import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDigest } from '../src/digest/render.mjs';

const baseStats = {
  raw: 90, scanned: 89, collapsed: 1, filtered: 41, belowThreshold: 16,
  minScore: 3, sources: ['watchlist', 'linkedin'], failedSources: [], rejectionSample: [],
};
const config = { sheet: { enabled: false }, digest: {} };

const job = (o) => ({
  id: o.id ?? 'a1', url: o.url ?? 'https://boards.greenhouse.io/acme/jobs/1',
  title: o.title ?? 'ML Engineer', company: o.company ?? 'Acme', location: o.location ?? 'Los Angeles, CA',
  source: 'watchlist', sourceDetail: 'greenhouse', postedAt: o.postedAt ?? '2026-09-11',
  watchlist: o.watchlist ?? false, score: o.score ?? 4, why: o.why ?? 'Ranking work in your home market.',
  heuristicOnly: o.heuristicOnly ?? false, modelScore: o.modelScore, bonus: o.bonus,
});

test('a zero-match day still renders a full digest', () => {
  const { html, text, headline } = renderDigest({ jobs: [], stats: baseStats, date: '2026-09-11', config });
  assert.equal(headline, 'No new matches today');
  assert.match(text, /No new matches today/);
  assert.match(text, /proof the run happened/, 'an empty digest says why it exists');
  assert.match(html, /89 posting/, 'the counts are still shown so you can see the scan ran');
});

test('one list in the order given, with the watchlist bonus on the badge', () => {
  const { html, text } = renderDigest({
    jobs: [
      job({ id: 'b1', company: 'Board Co', watchlist: false, score: 5 }),
      job({ id: 'w1', company: 'Watched Co', watchlist: true, score: 4, modelScore: 3.5, bonus: 0.5 }),
    ],
    stats: baseStats, date: '2026-09-11', config,
  });
  assert.ok(html.indexOf('Board Co') < html.indexOf('Watched Co'), 'a higher score comes first, watchlist or not');
  assert.doesNotMatch(html, /On your watchlist|Everything else/, 'there is no separate watchlist section');
  assert.match(html, /WATCHLIST \+0\.5/);
  assert.match(text, /\[watchlist \+0\.5\]/);
  assert.ok(text.indexOf('Board Co') < text.indexOf('Watched Co'));
});

test('degraded runs are declared at the top of the email', () => {
  const { html, text } = renderDigest({
    jobs: [job({})], stats: baseStats, date: '2026-09-11', config,
    warnings: ['ranking failed entirely (timeout) — roles are ordered by heuristic'],
  });
  assert.match(html, /Run was degraded/);
  assert.match(html, /ranking failed entirely/);
  assert.match(text, /RUN WAS DEGRADED/);
});

test('a heuristic-only score is marked, never passed off as a judgment', () => {
  const { html, text } = renderDigest({
    jobs: [job({ score: 3.4, heuristicOnly: true, why: null })],
    stats: baseStats, date: '2026-09-11', config,
  });
  assert.match(text, /\[3\.4\*\]/);
  assert.match(text, /scored heuristically/);
  assert.match(html, /3\.4\*/);
});

test('metadata-only rows always show the limited-evidence label', () => {
  const { html, text } = renderDigest({
    jobs: [job({ description: null, evidenceLevel: 'metadata_only' })],
    stats: baseStats, date: '2026-09-11', config,
  });
  assert.match(html, /Limited evidence: title, company and location only/);
  assert.match(text, /Limited evidence: title, company and location only/);
});

test('the digest states that Add is an intent, not a submission', () => {
  const { html, text } = renderDigest({
    jobs: [job({})], stats: baseStats, date: '2026-09-11',
    config: { sheet: { enabled: true, webapp_url: 'https://script.google.com/macros/s/AK/exec' }, digest: {} },
  });
  assert.match(html, /Add.{0,40}means.{0,40}want to apply/is);
  assert.match(html, /never submits anything/);
  assert.match(text, /never submits anything/);
});

test('untrusted posting text cannot inject markup into the email', () => {
  const { html } = renderDigest({
    jobs: [job({ company: '<script>alert(1)</script>', title: 'ML "Engineer" & Friends', why: '<img src=x onerror=1>' })],
    stats: baseStats, date: '2026-09-11', config,
  });
  assert.ok(!html.includes('<script>alert'), 'a script tag from a job board is escaped');
  assert.ok(!html.includes('<img src=x'), 'an img tag from a why line is escaped');
  assert.match(html, /&lt;script&gt;/);
});

test('without a configured sheet the digest hides Add actions without a degraded warning', () => {
  const { html } = renderDigest({ jobs: [job({})], stats: baseStats, date: '2026-09-11', config });
  assert.doesNotMatch(html, /Add buttons are off/);
  assert.doesNotMatch(html, /Add unavailable/);
  assert.match(html, /no Add actions/);
});

test('with a configured sheet every row gets a signed Add link', () => {
  process.env.HUNTLEY_LINK_SECRET = 'test-secret';
  const { html } = renderDigest({
    jobs: [job({ id: 'abc123' })], stats: baseStats, date: '2026-09-11',
    config: { sheet: { enabled: true, webapp_url: 'https://script.google.com/macros/s/AK/exec' }, digest: {} },
  });
  assert.match(html, /script\.google\.com[^"]*a=add[^"]*id=abc123/);
  assert.match(html, /sig=/);
  delete process.env.HUNTLEY_LINK_SECRET;
});
