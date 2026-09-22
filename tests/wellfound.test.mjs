import test from 'node:test';
import assert from 'node:assert/strict';
import { pageUrl, parseRolePage, planPages, searchWellfound } from '../src/sources/wellfound.mjs';
import { canAdvanceCheckpoint } from '../src/state/coverage.mjs';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const secs = (iso) => Math.floor(Date.parse(iso) / 1000);

/** A page in the shape Wellfound server-renders: Apollo state inside __NEXT_DATA__. */
function page({ recognised = true, pageCount = 1, startups }) {
  const data = { ROOT_QUERY: { talent: { __typename: 'Talent', viewer: {} } } };
  const t = data.ROOT_QUERY.talent;
  t['seoLandingPageJobSearchResults({"page":1})'] = {
    __typename: 'Results', totalJobCount: 99, pageCount,
    startups: startups.map((s) => ({ __ref: `StartupResult:${s.id}` })),
  };
  t[recognised ? 'seoLandingPageRoleAndLocation({"page":1})' : 'seoLandingPageLocation({"page":1})'] = { __ref: 'X:1' };
  for (const s of startups) {
    data[`StartupResult:${s.id}`] = { __typename: 'StartupResult', id: s.id, name: s.name, highlightedJobListings: s.jobs.map((j) => ({ __ref: `JobListingSearchResult:${j.id}` })) };
    for (const j of s.jobs) data[`JobListingSearchResult:${j.id}`] = { __typename: 'JobListingSearchResult', remote: false, locationNames: [], acceptedRemoteLocationNames: [], ...j };
  }
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { apolloState: { data } } } })}</script></html>`;
}

const fixture = page({
  pageCount: 2,
  startups: [
    { id: '1', name: 'DoorDash', jobs: [
      { id: '2967532', slug: 'machine-learning-engineer-conversation-ai', title: 'Machine Learning Engineer - Conversation AI', locationNames: ['Los Angeles', 'Seattle'], liveStartAt: secs('2026-09-10T00:00:00Z'), description: 'About the team…' },
      { id: '2903746', slug: 'old-role', title: 'ML Engineer, Ads', locationNames: ['San Francisco'], liveStartAt: secs('2024-03-29T00:00:00Z') },
    ] },
    { id: '2', name: 'Remote Co', jobs: [
      { id: '555', slug: 'research-engineer', title: 'Research Engineer', remote: true, acceptedRemoteLocationNames: ['United States'], liveStartAt: secs('2026-09-12T00:00:00Z') },
    ] },
  ],
});

test('role page URLs, and nothing that is not a slug', () => {
  assert.equal(pageUrl({ role: 'machine-learning-engineer', location: 'los-angeles' }), 'https://wellfound.com/role/l/machine-learning-engineer/los-angeles');
  assert.equal(pageUrl({ role: 'machine-learning-engineer', location: 'remote', page: 2 }), 'https://wellfound.com/role/r/machine-learning-engineer?page=2');
  assert.throws(() => pageUrl({ role: '../jobs', location: 'x' }));
});

test('a role page yields each startup\'s roles with company, places, date and description', () => {
  const p = parseRolePage(fixture);
  assert.equal(p.recognised, true);
  assert.equal(p.pageCount, 2);
  assert.equal(p.jobs.length, 3);
  assert.deepEqual(p.jobs[0], {
    id: '2967532',
    url: 'https://wellfound.com/jobs/2967532-machine-learning-engineer-conversation-ai',
    title: 'Machine Learning Engineer - Conversation AI',
    company: 'DoorDash',
    location: 'Los Angeles / Seattle',
    postedAt: '2026-09-10T00:00:00.000Z',
    description: 'About the team…',
    compensation: null,
    jobType: null,
  });
  assert.equal(p.jobs[2].location, 'Remote (United States)');
});

test('a page whose role Wellfound fell back from is marked unrecognised; a page with no data is null', () => {
  assert.equal(parseRolePage(page({ recognised: false, startups: [] })).recognised, false);
  assert.equal(parseRolePage('<html>Just a moment...</html>'), null);
});

test('the plan rotates by date so a capped run starts somewhere new each day', () => {
  const a = planPages({ roles: ['r1', 'r2'], locations: ['l1', 'l2'], today: '2026-09-13' });
  const b = planPages({ roles: ['r1', 'r2'], locations: ['l1', 'l2'], today: '2026-09-14' });
  assert.equal(a.length, 4);
  assert.notDeepEqual(a[0], b[0]);
  assert.deepEqual(new Set(a.map((c) => `${c.role}@${c.location}`)), new Set(b.map((c) => `${c.role}@${c.location}`)));
});

const run = (opts) => searchWellfound({ delayMs: 0, now: NOW, today: '2026-09-13', ...opts });

test('every planned page is read: first pages everywhere, then further pages where they exist', async () => {
  const urls = [];
  const { jobs, requests, warnings } = await run({
    roles: ['machine-learning-engineer', 'ai-engineer'], locations: ['los-angeles'], maxPages: 2,
    fetcher: async (url) => { urls.push(url); return { html: fixture }; },
  });
  assert.equal(requests, 4, 'two roles × two pages, all sent');
  assert.ok(!urls[0].includes('?page=') && !urls[1].includes('?page='), 'both first pages come before any second page');
  assert.deepEqual(warnings, []);
  assert.deepEqual(jobs.map((j) => j.title).sort(), ['Machine Learning Engineer - Conversation AI', 'Research Engineer'], 'the 2024 role is dropped; repeats across pages are not duplicated');
  assert.equal(jobs[0].source, 'wellfound');
  assert.ok(jobs.find((j) => j.company === 'DoorDash').description);
});

test('the safety limit stops a runaway plan and says so', async () => {
  const { requests, warnings, units } = await run({
    roles: ['machine-learning-engineer', 'ai-engineer'], locations: ['los-angeles'], maxPages: 2, requestLimit: 3,
    fetcher: async () => ({ html: fixture }),
  });
  assert.equal(requests, 3);
  assert.match(warnings[0], /4 pages planned but request_limit is 3/);
  assert.ok(units.some((u) => u.status === 'complete'), 'fully read combinations still complete');
  assert.ok(units.some((u) => u.status === 'partial'), 'unread remainder is partial');
});

test('a block stops the lane; an unrecognised role is reported and skipped', async () => {
  let calls = 0;
  const blocked = await run({ roles: ['a', 'b'], locations: ['x'], fetcher: async () => { calls++; return { blocked: 'HTTP 403' }; } });
  assert.equal(calls, 1);
  assert.match(blocked.warnings[0], /403.*stopped/);
  assert.equal(blocked.units[0].status, 'failed');
  assert.equal(blocked.units[1].status, 'partial');

  const unknown = await run({ roles: ['robotics-engineer'], locations: ['san-francisco'], fetcher: async () => ({ html: page({ recognised: false, startups: [{ id: '9', name: 'Any', jobs: [{ id: '1', title: 'Account Executive', liveStartAt: secs('2026-09-12T00:00:00Z') }] }] }) }) });
  assert.equal(unknown.jobs.length, 0, 'fallback results are not taken');
  assert.match(unknown.warnings[0], /does not recognise the role "robotics-engineer"/);
  assert.equal(unknown.units[0].status, 'unsupported');
});

test('catch-up bootstrap filters by max_age_days and leaves the older interval uncovered', async () => {
  const mid = page({
    pageCount: 1,
    startups: [{
      id: '1',
      name: 'Acme',
      jobs: [
        { id: 'recent', title: 'Research Engineer', liveStartAt: secs('2026-09-12T00:00:00Z') },
        { id: 'mid', title: 'Staff Engineer', liveStartAt: secs('2026-08-20T00:00:00Z') },
        { id: 'old', title: 'ML Engineer, Ads', liveStartAt: secs('2024-03-29T00:00:00Z') },
      ],
    }],
  });
  const { jobs, units } = await run({
    roles: ['machine-learning-engineer'],
    locations: ['los-angeles'],
    maxAgeDays: 14,
    maxPages: 1,
    collection: { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 },
    progress: { units: {} },
    fetcher: async () => ({ html: mid }),
  });
  assert.deepEqual(jobs.map((j) => j.title), ['Research Engineer']);
  assert.equal(units[0].status, 'partial');
  assert.equal(units[0].coveredThrough, null);
  assert.equal(canAdvanceCheckpoint(units[0]), false);
  assert.ok(Date.parse(units[0].requestedSince) < NOW - 30 * 86_400_000);
  assert.match(units[0].limitations.join(' '), /uncovered/);
});

test('max_pages leaves unread pages partial; a fetch error does not complete the combination', async () => {
  const unread = await run({
    roles: ['machine-learning-engineer'], locations: ['los-angeles'], maxPages: 1,
    fetcher: async () => ({ html: fixture }),
  });
  assert.equal(unread.units[0].status, 'partial');
  assert.match(unread.units[0].limitations.join(' '), /max_pages/);

  const errored = await run({
    roles: ['machine-learning-engineer'], locations: ['los-angeles'],
    fetcher: async () => ({ error: 'HTTP 500' }),
  });
  assert.equal(errored.units[0].status, 'failed');
  assert.equal(errored.jobs.length, 0);
});
