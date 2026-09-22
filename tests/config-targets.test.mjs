import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { validateTargets } from '../src/config.mjs';

test('the mis-nested block that silently disabled four exclusions is rejected', () => {
  // Exactly the shape produced by inserting a key mid-list: the items after it
  // re-parent under the new key and parse without complaint.
  const broken = yaml.load(`
exclude_titles:
  - software engineer
exclude_exceptions:
  - staff software engineer
  - director
  - "head of"
`);
  const problems = validateTargets(broken);
  assert.ok(problems.some((p) => /exclude_exceptions must map/.test(p) && /inserted in the middle/.test(p)));
});

test('a well-formed exception passes', () => {
  assert.deepEqual(validateTargets({
    role_terms: ['engineer*'], exclude_titles: ['software engineer'],
    exclude_exceptions: { 'software engineer': ['staff'] }, min_keyword_score: 0,
  }), []);
});

test('an exception for a term that is not excluded is reported', () => {
  const problems = validateTargets({ exclude_titles: ['security'], exclude_exceptions: { 'sofware engineer': ['staff'] } });
  assert.ok(problems.some((p) => /"sofware engineer", which is not in exclude_titles/.test(p)));
});

test('lists must be lists of strings, and the floor a non-negative number', () => {
  assert.ok(validateTargets({ exclude_titles: 'security' }).some((p) => /exclude_titles must be a list/.test(p)));
  assert.ok(validateTargets({ title_keywords: [{ a: 1 }] }).some((p) => /title_keywords must be a list/.test(p)));
  assert.ok(validateTargets({ min_keyword_score: -1 }).some((p) => /min_keyword_score/.test(p)));
});

test('keyword groups validate, and an @group reference must name a real group', () => {
  assert.deepEqual(validateTargets({
    title_keywords: { robotics: ['robotics'] }, exclude_titles: ['software engineer'],
    exclude_exceptions: { 'software engineer': ['staff', '@robotics'] },
  }), []);
  const problems = validateTargets({
    title_keywords: { robotics: ['robotics'] }, exclude_titles: ['software engineer'],
    exclude_exceptions: { 'software engineer': ['@robotcs'] },
  });
  assert.ok(problems.some((p) => /refers to @robotcs, but title_keywords has no group by that name/.test(p)));
  assert.ok(validateTargets({ title_keywords: { robotics: 'robotics' } }).some((p) => /title_keywords.robotics must be a list/.test(p)));
});

test('a ranking budget that cannot finish a single pass is rejected', async () => {
  const { validateRank } = await import('../src/config.mjs');

  // Shipped 2026-09-15: every field valid on its own, the combination unable
  // to rank more than one wave of four. It ranked 25 of 250 submitted roles.
  // Only reachable now by pinning the deadline by hand — left unset it is
  // derived from these same numbers and fits by construction.
  const shipped = validateRank({ max_llm: 250, batch_size: 25, timeout_ms: 180_000, total_timeout_ms: 300_000 });
  assert.equal(shipped.length, 1);
  assert.match(shipped[0], /total_timeout_ms \(300000\) cannot finish ranking/);
  assert.match(shipped[0], /4 wave\(s\) at concurrency 3, needing 720000ms/);

  // The deadline covers every wave even if each call runs to its timeout.
  assert.deepEqual(
    validateRank({ max_llm: 250, batch_size: 8, timeout_ms: 75_000, total_timeout_ms: 900_000 }),
    [],
  );

  // max_llm null submits every eligible role, so the wave count is not
  // knowable at config time; 0 turns model ranking off entirely.
  assert.deepEqual(validateRank({ max_llm: null, batch_size: 8, timeout_ms: 180_000, total_timeout_ms: 300_000 }), []);
  assert.deepEqual(validateRank({ max_llm: 0, total_timeout_ms: 300_000 }), []);
  assert.deepEqual(validateRank({}), [], 'the built-in defaults are self-consistent');
});

test('the shipped config and the example both pass validation', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  assert.doesNotThrow(() => loadConfig());
});

test('the ranking deadline is derived from the work, not from a constant', async () => {
  const { rankingDeadlineFor } = await import('../src/rank/llm.mjs');

  // The combination that shipped 2026-09-15: 10 calls, 4 waves at concurrency
  // 3, 180s each. It ran against a flat 300000 and lost three waves every run.
  assert.equal(
    rankingDeadlineFor({ submissions: 250, batchSize: 25, concurrency: 3, timeoutMs: 180_000 }),
    720_000,
  );
  // A small run does not wait for a big run's budget.
  assert.equal(rankingDeadlineFor({ submissions: 12, batchSize: 8, concurrency: 3, timeoutMs: 75_000 }), 75_000);
  // Degenerate inputs still yield one usable wave rather than a zero deadline.
  assert.equal(rankingDeadlineFor({ submissions: 0, batchSize: 8, concurrency: 3, timeoutMs: 75_000 }), 75_000);
  assert.equal(rankingDeadlineFor({ submissions: 5, batchSize: 0, concurrency: 0, timeoutMs: 1000 }), 5000);
});

test('an explicit deadline is still checked; a derived one needs no checking', async () => {
  const { validateRank } = await import('../src/config.mjs');
  assert.equal(validateRank({ max_llm: 250, batch_size: 25, timeout_ms: 180_000, total_timeout_ms: 300_000 }).length, 1);
  assert.deepEqual(validateRank({ max_llm: 250, batch_size: 25, timeout_ms: 180_000 }), [],
    'with no explicit deadline the same numbers are fine — the budget follows them');
  assert.deepEqual(validateRank({ total_timeout_ms: null }), []);
  assert.equal(validateRank({ total_timeout_ms: 'soon' }).length, 1);
});

test('freehire_feed.overlap_hours must be a nonnegative number', async () => {
  const { validateFreehireFeed } = await import('../src/config.mjs');
  assert.deepEqual(validateFreehireFeed({}), []);
  assert.deepEqual(validateFreehireFeed({ overlap_hours: 6 }), []);
  assert.deepEqual(validateFreehireFeed({ overlap_hours: 0 }), []);
  assert.equal(validateFreehireFeed({ overlap_hours: -1 }).length, 1);
});
