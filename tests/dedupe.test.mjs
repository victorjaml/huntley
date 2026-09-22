import test from 'node:test';
import assert from 'node:assert/strict';
import { toJob } from '../src/normalize.mjs';
import { dedupe, atsIdentity } from '../src/dedupe.mjs';

const job = (o) => toJob(o);

test('atsIdentity recognizes the major vendors', () => {
  assert.equal(atsIdentity('https://boards.greenhouse.io/acme/jobs/4012345'), 'greenhouse:acme:4012345');
  assert.equal(atsIdentity('https://job-boards.greenhouse.io/Acme/jobs/4012345?x=1'), 'greenhouse:acme:4012345');
  assert.equal(atsIdentity('https://jobs.lever.co/acme/8f1e2a3b-1111-2222-3333-444455556666'), 'lever:acme:8f1e2a3b-1111-2222-3333-444455556666');
  assert.equal(atsIdentity('https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), 'ashby:acme:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(atsIdentity('https://acme.wd1.myworkdayjobs.com/careers/job/San-Francisco/ML-Engineer_R-12345'), 'workday:acme:r-12345');
  assert.equal(atsIdentity('https://example.com/careers/ml-engineer'), null);
});

test('the same greenhouse req under different tracking params collapses to one', () => {
  const { jobs, collapsed } = dedupe([
    job({ url: 'https://boards.greenhouse.io/acme/jobs/4012345?utm_source=a', title: 'ML Engineer', company: 'Acme', source: 'ats_sweep' }),
    job({ url: 'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=b', title: 'ML Engineer', company: 'Acme Inc.', source: 'watchlist' }),
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(collapsed, 1);
});

test('a LinkedIn card and the ATS posting for one role collapse, keeping the ATS url', () => {
  const { jobs } = dedupe([
    job({ url: 'https://www.linkedin.com/jobs/view/4426311357', title: 'Senior ML Engineer', company: 'Acme, Inc.', location: 'Los Angeles, CA', postedAt: '2026-09-10', source: 'linkedin' }),
    job({ url: 'https://boards.greenhouse.io/acme/jobs/4012345', title: 'Senior ML Engineer (Remote)', company: 'Acme', description: 'Build models.', source: 'watchlist', watchlist: true }),
  ]);
  assert.equal(jobs.length, 1);
  const [only] = jobs;
  assert.match(only.url, /greenhouse/, 'apply link should be the company ATS, not the board');
  assert.equal(only.postedAt, '2026-09-10', 'posted date from the LinkedIn card survives the merge');
  assert.equal(only.description, 'Build models.', 'description from the ATS survives the merge');
  assert.equal(only.watchlist, true, 'watchlist flag is sticky across the merge');
  assert.ok(only.altUrls.some((u) => u.includes('linkedin')), 'the board copy is retained as an alt url');
});

test('an ATS copy is preferred over a freehire_feed copy of the same role', () => {
  const { jobs, collapsed } = dedupe([
    job({ url: 'https://freehire.me/jobs/1', title: 'ML Engineer', company: 'Acme', source: 'freehire_feed' }),
    job({ url: 'https://boards.greenhouse.io/acme/jobs/4012345', title: 'ML Engineer', company: 'Acme', source: 'watchlist' }),
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(collapsed, 1);
  assert.match(jobs[0].url, /greenhouse/);
});

test('two distinct requisitions that share a company and title stay separate', () => {
  const { jobs } = dedupe([
    job({ url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'ML Engineer', company: 'Acme', location: 'San Francisco, CA', source: 'watchlist' }),
    job({ url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'ML Engineer', company: 'Acme', location: 'San Francisco, CA', source: 'watchlist' }),
  ]);
  assert.equal(jobs.length, 2);
});

test('two genuinely different roles at one company stay separate', () => {
  const { jobs } = dedupe([
    job({ url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'ML Engineer', company: 'Acme', source: 'watchlist' }),
    job({ url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'Data Engineer', company: 'Acme', source: 'watchlist' }),
  ]);
  assert.equal(jobs.length, 2);
});

test('ids are stable across runs and independent of tracking params', () => {
  const a = dedupe([job({ url: 'https://boards.greenhouse.io/acme/jobs/9?utm_source=x', title: 'ML Engineer', company: 'Acme', source: 'watchlist' })]).jobs[0];
  const b = dedupe([job({ url: 'https://boards.greenhouse.io/acme/jobs/9', title: 'ML Engineer', company: 'Acme', source: 'linkedin' })]).jobs[0];
  assert.equal(a.id, b.id);
});

test('rows with no url or no title are dropped, not carried', () => {
  assert.equal(toJob({ url: '', title: 'ML Engineer', company: 'Acme' }), null);
  assert.equal(toJob({ url: 'https://x.com/a', title: '', company: 'Acme' }), null);
});
