import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractBoards, careersLinks, siteKey } from '../src/sources/funds/boards.mjs';
import { parseYc, parseCompanyLinks, parseWordpress, parseAtsLinks, fundProblem } from '../src/sources/funds/adapters.mjs';
import { resolveWebsite, guessBoard, nameFromTitle, compactRejected, REJECTED_TTL_MS } from '../src/sources/funds/resolve.mjs';
import { planFundScan, fundsByCompany, retireDeadFundBoards, TTL, applyResolvedSite } from '../src/sources/funds/index.mjs';
import { coverageUnit, unitKey } from '../src/state/coverage.mjs';
import { ycLocation, approxAgeDays, parseYcJobsPage, fetchYcJobs } from '../src/sources/funds/yc-jobs.mjs';

/** A fake HTTP layer: url → body (string or object), anything else is a 404. */
function fakeHttp(routes) {
  const calls = [];
  const lookup = (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => k === url || k === url.replace(/\/$/, ''));
    if (key === undefined) { const e = new Error('HTTP 404 Not Found'); e.status = 404; throw e; }
    const v = routes[key];
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    calls,
    fetchText: async (url) => { const v = lookup(url); return typeof v === 'string' ? v : JSON.stringify(v); },
    fetchJson: async (url) => { const v = lookup(url); return typeof v === 'string' ? JSON.parse(v) : v; },
    fetchTextHead: async (url) => { const v = lookup(url); return typeof v === 'string' ? v : ''; },
  };
}

// ── Board links ──────────────────────────────────────────────────────

const LINKS = {
  'https://job-boards.greenhouse.io/acme/jobs/123': ['greenhouse', 'https://job-boards.greenhouse.io/acme'],
  'https://boards.greenhouse.io/embed/job_board?for=acme': ['greenhouse', 'https://job-boards.greenhouse.io/acme'],
  'https://jobs.ashbyhq.com/acme/0b1c-uuid': ['ashby', 'https://jobs.ashbyhq.com/acme'],
  'https://jobs.lever.co/acme/abc-def': ['lever', 'https://jobs.lever.co/acme'],
  'https://apply.workable.com/acme/j/ABC123/': ['workable', 'https://apply.workable.com/acme'],
  'https://jobs.gem.com/acme/am9icG9zdA': ['gem', 'https://jobs.gem.com/acme'],
  'https://ats.rippling.com/en-GB/acme/jobs/1234': ['rippling', 'https://ats.rippling.com/acme/jobs'],
  'https://acme.bamboohr.com/careers/42': ['bamboohr', 'https://acme.bamboohr.com/careers'],
  'https://acme.breezy.hr/p/123-engineer': ['breezy', 'https://acme.breezy.hr'],
  'https://jobs.jobvite.com/acme/job/o123': ['jobvite', 'https://jobs.jobvite.com/acme'],
  'https://acme.recruitee.com/o/engineer': ['recruitee', 'https://acme.recruitee.com'],
  'https://jobs.smartrecruiters.com/Acme/7430000': ['smartrecruiters', 'https://jobs.smartrecruiters.com/Acme'],
  'https://acme.pinpointhq.com/en/postings/1': ['pinpoint', 'https://acme.pinpointhq.com'],
  'https://acme.teamtailor.com/jobs/1-engineer': ['teamtailor', 'https://acme.teamtailor.com/jobs'],
  'https://acme.jobs.personio.com/job/1': ['personio', 'https://acme.jobs.personio.com'],
  'https://acme.applytojob.com/apply/abc/Engineer': ['jazzhr', 'https://acme.applytojob.com/apply'],
  'https://acme.wd5.myworkdayjobs.com/en-US/External/job/LA/Engineer_R1': ['workday', 'https://acme.wd5.myworkdayjobs.com/External'],
};

test('a link to any supported job board yields that board', () => {
  for (const [link, [vendor, careersUrl]] of Object.entries(LINKS)) {
    const [board] = extractBoards(`<a href="${link}">Apply</a>`);
    assert.ok(board, `no board found in ${link}`);
    assert.equal(board.vendor, vendor, link);
    assert.equal(board.careers_url, careersUrl, link);
  }
});

test('every board URL is one its Huntley provider scans', async () => {
  const V = '../src/sources/boards/providers/';
  for (const [link, [vendor]] of Object.entries(LINKS)) {
    const provider = (await import(`${V}${vendor}.mjs`)).default;
    const [board] = extractBoards(link);
    assert.ok(provider.detect({ name: 'Acme', careers_url: board.careers_url }), `${vendor} does not detect ${board.careers_url}`);
  }
});

test('board links inside embedded JSON are found, and the most-linked board comes first', () => {
  const html = `<script>{"a":"https:\\/\\/jobs.ashbyhq.com\\/partner"}</script>
    <a href="https://jobs.lever.co/acme/1">1</a><a href="https://jobs.lever.co/acme/2">2</a>`;
  const boards = extractBoards(html);
  assert.equal(boards[0].careers_url, 'https://jobs.lever.co/acme');
  assert.equal(boards[0].count, 2);
  assert.ok(boards.some((b) => b.careers_url === 'https://jobs.ashbyhq.com/partner'));
});

test('path segments that only look like slugs are not boards', () => {
  assert.deepEqual(extractBoards('https://jobs.lever.co/api https://www.bamboohr.com https://app.breezy.hr'), []);
});

test('careers links are same-site links that say careers, jobs or join us', () => {
  const html = `
    <a href="/about">About</a>
    <a href="/company/careers">Careers</a>
    <a href="https://jobs.acme.com/">Open roles</a>
    <a href="/team">Join the team</a>
    <a href="https://other.com/careers">Their careers</a>`;
  assert.deepEqual(careersLinks(html, 'https://www.acme.com/'), [
    'https://www.acme.com/company/careers',
    'https://jobs.acme.com/',
    'https://www.acme.com/team',
  ]);
});

test('siteKey folds scheme and www', () => {
  assert.equal(siteKey('https://www.Acme.ai/path'), 'acme.ai');
  assert.equal(siteKey('acme.ai'), 'acme.ai');
  assert.equal(siteKey('mailto:hi@acme.ai'), '');
});

// ── Adapters ─────────────────────────────────────────────────────────

test('yc: only active, hiring companies by default', () => {
  const payload = [
    { name: 'Hiring', slug: 'hiring', website: 'https://hiring.ai', isHiring: true, status: 'Active', batch: 'W24' },
    { name: 'Quiet', slug: 'quiet', website: 'https://quiet.ai', isHiring: false, status: 'Active' },
    { name: 'Gone', slug: 'gone', website: 'https://gone.ai', isHiring: true, status: 'Inactive' },
  ];
  assert.deepEqual(parseYc(payload).map((c) => c.name), ['Hiring']);
  assert.equal(parseYc(payload)[0].ycSlug, 'hiring');
  assert.deepEqual(parseYc(payload, { hiringOnly: false }).map((c) => c.name), ['Hiring', 'Quiet']);
});

test('company_links: one company per external site, named from its card', () => {
  const html = `
    <a href="https://www.fund.vc/team">Team</a>
    <a href="https://www.linkedin.com/company/fund">LinkedIn</a>
    <a href="https://cdn.prod.website-files.com/logo.png">x</a>
    <a class="portfolio_card" href="https://www.authzed.com/"><div>Authzed</div><div>Managed permissions</div></a>
    <a href="https://arthur.ai"><img src="a.png" alt="Arthur logo"></a>
    <a href="https://jobs.ashbyhq.com/acme">Jobs</a>`;
  assert.deepEqual(parseCompanyLinks(html, 'https://www.fund.vc/portfolio'), [
    { name: 'Authzed', website: 'https://authzed.com' },
    { name: 'Arthur', website: 'https://arthur.ai' },
  ]);
});

test('wordpress: title and link per portfolio post', () => {
  assert.deepEqual(parseWordpress([
    { title: { rendered: 'Blue &amp; Berry' }, link: 'https://blueberry.ai/' },
    { title: { rendered: 'No site' }, link: 'https://pear.vc/?post_type=pear_vc_company&p=1' },
  ]), [
    { name: 'Blue & Berry', website: 'https://blueberry.ai/' },
    { name: 'No site', website: null },
  ]);
});

test('ats_links: boards with no names yet', () => {
  const [c] = parseAtsLinks('<a href="https://jobs.lever.co/lyrahealth/1">Apply</a>');
  assert.equal(c.name, null);
  assert.equal(c.board.careers_url, 'https://jobs.lever.co/lyrahealth');
});

test('a fund entry with a missing field or unknown kind is reported', () => {
  assert.equal(fundProblem({ name: 'YC', kind: 'yc' }), null);
  assert.match(fundProblem({ name: 'X', kind: 'ats_links' }), /needs url/);
  assert.match(fundProblem({ name: 'X', kind: 'rss' }), /unknown kind/);
});

// ── Resolution ───────────────────────────────────────────────────────

test('a board linked from the careers page the homepage points to', async () => {
  const http = fakeHttp({
    'https://acme.ai/': '<a href="/join-us">Join us</a>',
    'https://acme.ai/join-us': '<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>',
    'https://boards-api.greenhouse.io/v1/boards/acme': { name: 'Acme' },
  });
  const r = await resolveWebsite('https://www.acme.ai', http);
  assert.equal(r.status, 'found');
  assert.equal(r.board.careers_url, 'https://job-boards.greenhouse.io/acme');
});

test('with no careers link, /careers is tried; a site with no board says none', async () => {
  const found = await resolveWebsite('https://acme.ai', fakeHttp({
    'https://acme.ai/': '<p>hello</p>',
    'https://acme.ai/careers': '<a href="https://jobs.ashbyhq.com/acme">roles</a>',
    'https://api.ashbyhq.com/posting-api/job-board/acme': { jobs: [] },
  }));
  assert.equal(found.board?.careers_url, 'https://jobs.ashbyhq.com/acme');
  assert.deepEqual(await resolveWebsite('https://acme.ai', fakeHttp({ 'https://acme.ai/': '<p>hi</p>' })), { status: 'none' });
  assert.equal((await resolveWebsite('https://down.ai', fakeHttp({}))).status, 'error');
});

test('a dead Greenhouse link is skipped for a live Ashby board on the same page', async () => {
  const http = fakeHttp({
    'https://trmlabs.com/': `
      <a href="https://job-boards.greenhouse.io/trmlabs">Greenhouse</a>
      <a href="https://job-boards.greenhouse.io/trmlabs/jobs/1">role</a>
      <a href="https://job-boards.greenhouse.io/trmlabs/jobs/2">role</a>
      <a href="https://jobs.ashbyhq.com/trm-labs">Ashby</a>`,
    'https://api.ashbyhq.com/posting-api/job-board/trm-labs': { jobs: [{ title: 'Engineer' }] },
  });
  const r = await resolveWebsite('https://trmlabs.com', http);
  assert.equal(r.status, 'found');
  assert.equal(r.board.careers_url, 'https://jobs.ashbyhq.com/trm-labs');
  assert.ok(r.rejected.some((x) => /greenhouse\.io\/trmlabs/.test(x.careers_url)));
});

test('percent-encoded Ashby slugs are decoded, then encoded in the board URL', () => {
  const html = '<a href="https://jobs.ashbyhq.com/Honey%20Homes">Jobs</a>';
  const [board] = extractBoards(html);
  assert.equal(board.slug, 'Honey Homes');
  assert.equal(board.careers_url, 'https://jobs.ashbyhq.com/Honey%20Homes');
});

test('encoded share and redirect wrappers yield the bare slug', () => {
  const [lever] = extractBoards('share?url=https%3A%2F%2Fjobs.lever.co%2Facme%3Flever-source%3Dlinkedin');
  assert.equal(lever.slug, 'acme');
  assert.equal(lever.careers_url, 'https://jobs.lever.co/acme');
  const [ashby] = extractBoards('redirect?to=https%3A%2F%2Fjobs.ashbyhq.com%2Fnotion%3Futm_source%3Dsite');
  assert.equal(ashby.slug, 'notion');
  assert.equal(ashby.careers_url, 'https://jobs.ashbyhq.com/notion');
});

test('Teamtailor regional hosts are not company boards', () => {
  assert.deepEqual(extractBoards('<a href="https://na.teamtailor.com/jobs">careers</a>'), []);
  assert.ok(extractBoards('<a href="https://acme.teamtailor.com/jobs">careers</a>')[0]);
});

test('a Workday bare locale is skipped; the next path segment is the site', () => {
  assert.deepEqual(extractBoards('https://rappi.wd12.myworkdayjobs.com/es'), []);
  const [board] = extractBoards('<a href="https://rappi.wd12.myworkdayjobs.com/es/Rappi">Jobs</a>');
  assert.equal(board.vendor, 'workday');
  assert.equal(board.careers_url, 'https://rappi.wd12.myworkdayjobs.com/Rappi');
});

test('a guessed board is accepted only when it names itself as the company', async () => {
  const routes = {
    'https://boards-api.greenhouse.io/v1/boards/stripe': { name: 'Stripe' },
    'https://boards-api.greenhouse.io/v1/boards/streak': { name: 'Streak Ventures' },
  };
  const stripe = await guessBoard({ name: 'Stripe', website: 'https://stripe.com' }, fakeHttp(routes));
  assert.equal(stripe.board?.careers_url, 'https://job-boards.greenhouse.io/stripe');
  assert.equal((await guessBoard({ name: 'Streak', website: 'https://streak.com' }, fakeHttp(routes))).status, 'none');
});

test('a short name alone is never guessed from', async () => {
  const http = fakeHttp({ 'https://boards-api.greenhouse.io/v1/boards/raven': { name: 'Raven' } });
  assert.equal((await guessBoard({ name: 'Raven', website: 'https://startraven.com' }, http)).status, 'none');
  assert.ok(!http.calls.some((u) => u.endsWith('/raven')), 'the five-letter name was not probed');
});

test('board page titles become company names', () => {
  assert.equal(nameFromTitle('Cognition Jobs'), 'Cognition');
  assert.equal(nameFromTitle('Hugging Face - Current Openings'), 'Hugging Face');
  assert.equal(nameFromTitle('Jobs at Lyra Health | Lever'), 'Lyra Health');
  assert.equal(nameFromTitle('Jobs'), null);
  assert.equal(nameFromTitle('404 page not found'), null);
});

// ── Planning ─────────────────────────────────────────────────────────

test('planning merges funds, skips watchlist boards, and sends board-less YC companies to YC pages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const http = fakeHttp({
    'https://yc.example/all.json': [
      { name: 'Shared', slug: 'shared', website: 'https://shared.ai', isHiring: true, status: 'Active' },
      { name: 'NoBoard', slug: 'noboard', website: 'https://noboard.ai', isHiring: true, status: 'Active' },
      { name: 'Watched', slug: 'watched', website: 'https://watched.ai', isHiring: true, status: 'Active' },
    ],
    'https://fund.vc/portfolio': '<a href="https://www.shared.ai">Shared</a>',
    'https://shared.ai/': '<a href="https://jobs.ashbyhq.com/shared">Careers</a>',
    'https://api.ashbyhq.com/posting-api/job-board/shared': { jobs: [] },
    'https://noboard.ai/': '<p>coming soon</p>',
    'https://watched.ai/': '<a href="https://jobs.lever.co/watched">Careers</a>',
    'https://api.lever.co/v0/postings/watched?limit=1&mode=json': [],
  });
  const plan = await planFundScan([
    { name: 'Y Combinator', kind: 'yc', url: 'https://yc.example/all.json' },
    { name: 'Other Fund', kind: 'company_links', url: 'https://fund.vc/portfolio' },
    { name: 'Broken', kind: 'nope' },
  ], { http, dir, skipBoards: new Set(['https://jobs.lever.co/watched']) });

  assert.deepEqual(plan.entries, [
    { name: 'Shared', careers_url: 'https://jobs.ashbyhq.com/shared', provider: 'ashby', funds: ['Y Combinator', 'Other Fund'] },
  ]);
  assert.deepEqual(plan.waas.map((w) => w.ycSlug), ['noboard']);
  assert.equal(plan.stats.skipped, 1);
  assert.ok(plan.warnings.some((w) => /Broken.*unknown kind/.test(w)));
  assert.deepEqual(fundsByCompany(plan.entries, plan.waas).get('shared'), ['Y Combinator', 'Other Fund']);

  // Resolutions are cached: a second plan fetches no company website.
  const resolved = JSON.parse(readFileSync(join(dir, 'resolved.json'), 'utf8'));
  assert.equal(resolved.sites['shared.ai'].status, 'found');
  http.calls.length = 0;
  await planFundScan([{ name: 'Y Combinator', kind: 'yc', url: 'https://yc.example/all.json' }], { http, dir });
  assert.ok(!http.calls.some((u) => /shared\.ai|noboard\.ai/.test(u)), `refetched: ${http.calls.join(', ')}`);
});

test('a fund page that fails falls back to its last list and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const fund = { name: 'Fund', kind: 'ats_links', url: 'https://fund.vc/jobs' };
  const ok = fakeHttp({ 'https://fund.vc/jobs': '<a href="https://jobs.ashbyhq.com/acme/1">x</a>', 'https://jobs.ashbyhq.com/acme': '<title>Acme Jobs</title>' });
  const first = await planFundScan([fund], { http: ok, dir });
  assert.equal(first.entries[0].name, 'Acme');

  const later = Date.now() + 2 * 86_400_000; // past the list's daily refresh
  const down = await planFundScan([fund], { http: fakeHttp({ 'https://fund.vc/jobs': new Error('HTTP 503') }), dir, now: later });
  assert.equal(down.entries.length, 1, 'yesterday\'s boards are still scanned');
  assert.ok(down.warnings.some((w) => /Fund.*HTTP 503.*last list/.test(w)));
});

test('a timeout or 503 during a board check is an error, not dead_link', async () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const timedOut = await resolveWebsite('https://slow.ai', fakeHttp({
    'https://slow.ai/': '<a href="https://jobs.ashbyhq.com/slow">Jobs</a>',
    'https://api.ashbyhq.com/posting-api/job-board/slow': timeout,
  }));
  assert.equal(timedOut.status, 'error');
  assert.notEqual(timedOut.status, 'dead_link');

  const unavailable = Object.assign(new Error('HTTP 503'), { status: 503 });
  const overloaded = await resolveWebsite('https://busy.ai', fakeHttp({
    'https://busy.ai/': '<a href="https://jobs.ashbyhq.com/busy">Jobs</a>',
    'https://api.ashbyhq.com/posting-api/job-board/busy': unavailable,
  }));
  assert.equal(overloaded.status, 'error');
  assert.notEqual(overloaded.status, 'dead_link');
});

test('a retired unverifiable board is not picked again', async () => {
  const http = fakeHttp({
    'https://acme.ai/': '<a href="https://apply.workable.com/dead">Jobs</a>',
  });
  const first = await resolveWebsite('https://acme.ai', http);
  assert.equal(first.status, 'found');
  assert.equal(first.board.careers_url, 'https://apply.workable.com/dead');

  const again = await resolveWebsite('https://acme.ai', http, {
    rejected: [{ careers_url: 'https://apply.workable.com/dead', status: 404 }],
  });
  assert.equal(again.status, 'dead_link');
  assert.equal(again.board, undefined);
});

test('a 404 fund board is retired as dead_link; a timeout is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const now = Date.parse('2026-09-18T12:00:00Z');
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({
    sites: {
      'dead.ai': { status: 'found', checkedAt: now, board: { vendor: 'ashby', slug: 'dead', careers_url: 'https://jobs.ashbyhq.com/dead' } },
      'slow.ai': { status: 'found', checkedAt: now, board: { vendor: 'ashby', slug: 'slow', careers_url: 'https://jobs.ashbyhq.com/slow' } },
    },
  }));
  const retired = retireDeadFundBoards(dir, [
    coverageUnit({
      key: unitKey('fund:board', 'https://jobs.ashbyhq.com/dead'),
      status: 'failed',
      errors: ['HTTP 404 Not Found'],
    }),
    coverageUnit({
      key: unitKey('fund:board', 'https://jobs.ashbyhq.com/slow'),
      status: 'failed',
      errors: ['timed out after 30000ms'],
    }),
  ], { now });
  assert.equal(retired, 1);
  const cache = JSON.parse(readFileSync(join(dir, 'resolved.json'), 'utf8'));
  assert.equal(cache.sites['dead.ai'].status, 'dead_link');
  assert.ok(now - cache.sites['dead.ai'].checkedAt >= TTL.dead_link, 'next run re-resolves immediately');
  assert.equal(cache.sites['slow.ai'].status, 'found');
});

test('a deadline cut-off leaves the cache entry unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const prev = { status: 'none', checkedAt: 42 };
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ sites: { 'cut.ai': prev } }));

  const inner = fakeHttp({
    'https://yc.example/all.json': [{ name: 'Cut', slug: 'cut', website: 'https://cut.ai', isHiring: true, status: 'Active' }],
    'https://cut.ai/': '<a href="https://jobs.ashbyhq.com/cut">Jobs</a>',
  });
  const http = {
    ...inner,
    fetchJson: async (url) => {
      if (/posting-api/.test(url)) await new Promise((r) => setTimeout(r, 150));
      return inner.fetchJson(url);
    },
  };
  const plan = await planFundScan(
    [{ name: 'Y Combinator', kind: 'yc', url: 'https://yc.example/all.json' }],
    { http, dir, budgetMs: 30 },
  );
  const cache = JSON.parse(readFileSync(join(dir, 'resolved.json'), 'utf8'));
  assert.equal(cache.sites['cut.ai'].status, 'none');
  assert.equal(cache.sites['cut.ai'].checkedAt, 42);
  assert.equal(plan.stats.resolvedNow, 0);
  assert.equal(plan.stats.pendingAfterBudget, 1);

  const found = { status: 'found', checkedAt: 7, board: { vendor: 'ashby', slug: 'kept' } };
  assert.equal(applyResolvedSite(found, { status: 'error', error: 'board check reached the resolve deadline', deadline: true }), found);
  assert.equal(applyResolvedSite(undefined, { status: 'error', deadline: true }), undefined);
});

test('a 503 on re-check keeps a found board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const now = Date.now();
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({
    sites: {
      'live.ai': {
        status: 'found',
        checkedAt: now - TTL.found - 1,
        board: { vendor: 'ashby', slug: 'live', careers_url: 'https://jobs.ashbyhq.com/live' },
      },
    },
  }));
  const unavailable = Object.assign(new Error('HTTP 503'), { status: 503 });
  const http = fakeHttp({
    'https://yc.example/all.json': [{ name: 'Live', slug: 'live', website: 'https://live.ai', isHiring: true, status: 'Active' }],
    'https://live.ai/': '<a href="https://jobs.ashbyhq.com/live">Jobs</a>',
    'https://api.ashbyhq.com/posting-api/job-board/live': unavailable,
  });
  const plan = await planFundScan(
    [{ name: 'Y Combinator', kind: 'yc', url: 'https://yc.example/all.json' }],
    { http, dir, now },
  );
  assert.equal(plan.entries.length, 1, 'the live board is still scanned');
  assert.equal(plan.entries[0].careers_url, 'https://jobs.ashbyhq.com/live');
  const cache = JSON.parse(readFileSync(join(dir, 'resolved.json'), 'utf8'));
  assert.equal(cache.sites['live.ai'].status, 'found');
  assert.equal(cache.sites['live.ai'].board.slug, 'live');
  assert.ok(now - cache.sites['live.ai'].checkedAt < TTL.found, 'still treated as found this run');
  assert.ok(now - cache.sites['live.ai'].checkedAt >= TTL.found - TTL.error - 5_000, 'retries in ~2 days');
});

test('repeated timeouts leave one entry per URL', async () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const http = fakeHttp({
    'https://flaky.ai/': '<a href="https://jobs.ashbyhq.com/flaky">Jobs</a>',
    'https://api.ashbyhq.com/posting-api/job-board/flaky': timeout,
  });
  let rejected = [];
  const sizes = [];
  for (let i = 0; i < 5; i++) {
    const r = await resolveWebsite('https://flaky.ai', http, { rejected });
    assert.equal(r.status, 'error');
    rejected = r.rejected ?? [];
    sizes.push(rejected.length);
  }
  assert.deepEqual(sizes, [0, 0, 0, 0, 0], 'timeouts are not carried between resolves');

  const now = Date.parse('2026-09-18T12:00:00Z');
  const url = 'https://jobs.ashbyhq.com/gone';
  const piled = compactRejected([
    { careers_url: url, status: 404, at: now - 1000 },
    { careers_url: `${url}/`, status: 404, at: now },
    { careers_url: url, status: 503, at: now },
  ], { now });
  assert.equal(piled.length, 1);
  assert.equal(piled[0].status, 404);
  assert.equal(compactRejected([{ careers_url: url, status: 404, at: now - REJECTED_TTL_MS - 1 }], { now }).length, 0);
});

test('with no budget left, new companies wait and YC companies use their YC page meanwhile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-funds-'));
  const http = fakeHttp({ 'https://yc.example/all.json': [{ name: 'New', slug: 'new-co', website: 'https://new.ai', isHiring: true }] });
  const plan = await planFundScan([{ name: 'Y Combinator', kind: 'yc', url: 'https://yc.example/all.json' }], { http, dir, budgetMs: 0 });
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.stats.pendingAfterBudget, 1);
  assert.deepEqual(plan.waas.map((w) => w.ycSlug), ['new-co']);
});

// ── YC pages ─────────────────────────────────────────────────────────

test('YC country codes are spelled out, and state codes are left alone', () => {
  assert.equal(ycLocation('CA / Remote (US; CA)'), 'Canada / Remote (United States; Canada)');
  assert.equal(ycLocation('Toronto, ON, CA'), 'Toronto, ON, Canada');
  assert.equal(ycLocation('San Francisco, CA, US'), 'San Francisco, CA, United States');
  assert.equal(ycLocation('San Francisco, CA'), 'San Francisco, CA');
});

test('YC fuzzy ages', () => {
  assert.equal(approxAgeDays('3 days'), 3);
  assert.equal(approxAgeDays('about 1 month'), 30);
  assert.equal(approxAgeDays('over 2 years'), 730);
  assert.equal(approxAgeDays('about 5 hours'), 0);
  assert.equal(approxAgeDays('a day'), 1);
  assert.equal(approxAgeDays(''), null);
});

const ycPage = (postings) => `<div data-page="${JSON.stringify({ component: 'WaasShowJobsPage', props: { company: { name: 'Acme' }, jobPostings: postings } })
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div>`;

test('YC job pages are read, and old roles dropped', async () => {
  const html = ycPage([
    { title: 'ML Engineer &amp; Researcher', url: '/companies/acme/jobs/a1-ml', location: 'San Francisco, CA, US', companyName: 'Acme', createdAt: '2 days' },
    { title: 'Old Role', url: '/companies/acme/jobs/b2-old', location: 'US / Remote (US)', companyName: 'Acme', createdAt: 'over 2 years' },
  ]);
  const parsed = parseYcJobsPage(html);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'ML Engineer & Researcher');

  const { jobs } = await fetchYcJobs([{ name: 'Acme', ycSlug: 'acme', funds: ['Y Combinator'] }], {
    http: fakeHttp({ 'https://www.ycombinator.com/companies/acme/jobs': html }),
    maxAgeDays: 30,
  });
  assert.deepEqual(jobs.map((j) => j.title), ['ML Engineer & Researcher']);
  assert.match(jobs[0].url, /^https:\/\/(www\.)?ycombinator\.com\/companies\/acme\/jobs\/a1-ml$/);
  assert.equal(jobs[0].source, 'portfolio');
  assert.match(jobs[0].sourceDetail, /Y Combinator/);
});

test('Ashby encodes a slug with spaces when building the posting-api URL', async () => {
  const ashby = (await import('../src/sources/boards/providers/ashby.mjs')).default;
  const detected = ashby.detect({ name: 'Honey Homes', careers_url: 'https://jobs.ashbyhq.com/Honey%20Homes' });
  assert.equal(detected.url, 'https://api.ashbyhq.com/posting-api/job-board/Honey%20Homes?includeCompensation=true');
});
