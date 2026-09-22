import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freehireBoard, groupSources, feedJob, readFreehireFeed, DEFAULT_EXCLUDE } from '../src/sources/freehire-feed.mjs';
import { recordActiveBoards, activeBoards } from '../src/sources/active-boards.mjs';
import { builtinBoards } from '../src/sources/ats-lanes.mjs';

// Rows in the shape freehire's /jobs/search returns (verified 2026-09-14).
const row = (source, external_id, url, o = {}) => ({ source, external_id, url, title: 'ML Engineer', company: 'Acme', location: 'San Francisco, CA', posted_at: '2026-09-13T10:00:00Z', ...o });

test('boards from the job URL, or from freehire\'s external_id when the URL does not name one', () => {
  const cases = [
    [row('rippling', 'lyte:77c2', 'https://ats.rippling.com/lyte/jobs/77c2?utm_source=freehire.me'), 'https://ats.rippling.com/lyte/jobs'],
    [row('workable', 'laborup:3916CC95AE', 'https://apply.workable.com/j/3916CC95AE?utm_source=freehire.me'), 'https://apply.workable.com/laborup'],
    [row('smartrecruiters', 'endeavourgroupcareers:7440', 'https://jobs.smartrecruiters.com/EndeavourGroupCareers/7440-chef'), 'https://jobs.smartrecruiters.com/EndeavourGroupCareers'],
    [row('greenhouse', 'axiomtalentplatform:8797', 'https://www.axiomlaw.com/careers/lawyers/8797?gh_jid=8797'), 'https://job-boards.greenhouse.io/axiomtalentplatform'],
    [row('jazzhr', 'axiomcustom:HdbL5ngpzL', 'https://axiomcustom.applytojob.com/apply/HdbL5ngpzL/Manager'), 'https://axiomcustom.applytojob.com/apply'],
    [row('icims', 'wipfli:8097', 'https://careers-wipfli.icims.com/jobs/8097/product-owner/job'), 'https://careers-wipfli.icims.com/jobs/search?ss=1&in_iframe=1'],
    [row('avature', 'mantech.avature.net:65998', 'https://careers.mantech.com/en_US/careers/JobDetail/Tech/65998'), 'https://mantech.avature.net/careers'],
    [row('oracle', 'fa-etjg-saasfaprod1.fa.ocs.oraclecloud.com/Chilis:14577', 'https://fa-etjg-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Chilis/job/14577'), 'https://fa-etjg-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Chilis'],
    [row('phenom', 'careers.molsoncoors.com:MQX39483', 'https://careers.molsoncoors.com/us/en/job/MQX39483'), 'https://careers.molsoncoors.com/us/en'],
    [row('successfactors', 'jobs.tetrapak.com:1390568933', 'https://jobs.tetrapak.com/job/Tech/1390568933/'), 'https://jobs.tetrapak.com'],
  ];
  for (const [r, expected] of cases) assert.equal(freehireBoard(r)?.careers_url, expected, r.source);
  assert.equal(freehireBoard(cases[7][0]).provider, 'oraclecloud', 'systems on custom domains name their provider');
  assert.equal(freehireBoard(row('eightfold', 'ericsson.eightfold.ai/ericsson.com:5631', 'https://jobs.ericsson.com/careers/job/5631')), null, 'not read directly');
  assert.equal(freehireBoard(row('avature', 'not a host:1', 'https://x.test/1')), null);
});

test('every enterprise board names a real Huntley provider, in a shape it accepts', async () => {
  const V = '../src/sources/boards/providers/';
  const boards = [
    freehireBoard(row('icims', 'wipfli:8097', 'https://careers-wipfli.icims.com/jobs/8097/x/job')),
    freehireBoard(row('avature', 'jackhenry.avature.net:17440', 'https://jackhenry.avature.net/careers/JobDetail/x/17440')),
    freehireBoard(row('oracle', 'fa-etjg-saasfaprod1.fa.ocs.oraclecloud.com/Chilis:1', 'https://fa-etjg-saasfaprod1.fa.ocs.oraclecloud.com/x')),
    freehireBoard(row('phenom', 'careers.molsoncoors.com:M1', 'https://careers.molsoncoors.com/us/en/job/M1')),
  ];
  for (const b of boards) {
    const provider = (await import(`${V}${b.provider}.mjs`)).default;
    assert.equal(provider.id, b.provider, 'the provider named is a real Huntley provider');
    assert.equal(typeof provider.fetch, 'function');
    if (provider.detect) assert.ok(provider.detect({ name: 'x', careers_url: b.careers_url }), `${b.provider} does not detect ${b.careers_url}`);
  }
});

test('sources are grouped under the 10,000-row paging cap', () => {
  const groups = groupSources({ adp: 6415, smartrecruiters: 1818, oracle: 1250, workable: 1112, gem: 12, none: 0 }, 9_000);
  assert.deepEqual(groups.map((g) => g.sources), [['adp', 'smartrecruiters'], ['oracle', 'workable', 'gem']]);
  assert.ok(groups.every((g) => g.total <= 9_000));
});

test('a feed row becomes a job without freehire\'s tracking parameter, carrying its board', () => {
  const j = feedJob(row('gem', 'obin-ai:am9', 'https://jobs.gem.com/obin-ai/am9?utm_source=freehire.me'));
  assert.equal(j.url, 'https://jobs.gem.com/obin-ai/am9');
  assert.equal(j.source, 'freehire_feed');
  assert.equal(j.sourceDetail, 'freehire:gem');
  assert.equal(j.board.careers_url, 'https://jobs.gem.com/obin-ai');
});

test('the feed reads every page of every source group, excluding covered sources, and keeps only what passes', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const rows = Array.from({ length: 250 }, (_, i) => row('workable', `acme:${i}`, `https://apply.workable.com/j/${i}`, { title: i % 2 ? 'ML Engineer' : 'Sales Lead' }));
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const json = u.pathname.endsWith('/facets')
      ? { data: { facets: { source: { workable: 250, greenhouse: 999, 'whatjobs-uk': 5 } } }, meta: {} }
      : { data: rows.slice(Number(u.searchParams.get('offset')), Number(u.searchParams.get('offset')) + 100), meta: {} };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'x-ratelimit-remaining': '500' } });
  };
  try {
    const res = await readFreehireFeed({ keep: (jobs) => jobs.filter((j) => j.title === 'ML Engineer') });
    const searches = calls.filter((u) => u.pathname.endsWith('/search'));
    assert.equal(searches.length, 3, '250 rows in pages of 100');
    assert.ok(searches.every((u) => u.searchParams.getAll('source').join() === 'workable'), 'greenhouse and whatjobs-* are excluded');
    assert.ok(searches.every((u) => u.searchParams.get('sort') === 'created_at' && u.searchParams.get('order') === 'asc'));
    assert.equal(res.total, 250);
    assert.equal(res.jobs.length, 125);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(DEFAULT_EXCLUDE.includes('workday'));
});

test('a parameter freehire ignores stops the feed rather than returning the whole catalogue', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { facets: { source: {} } }, meta: { ignored_params: [{ param: 'open_within_days' }] } }), { status: 200 });
  try {
    await assert.rejects(readFreehireFeed({}), /ignored open_within_days/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an active board keeps the provider it needs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'huntley-active-')), 'active.json');
  const board = freehireBoard(row('oracle', 'eeho.fa.us2.oraclecloud.com/CX_45001:1', 'https://eeho.fa.us2.oraclecloud.com/x'));
  recordActiveBoards([{ url: 'https://eeho.fa.us2.oraclecloud.com/x', company: 'Oracle', board }], { path, date: '2026-09-13' });
  assert.deepEqual(activeBoards({ path, today: '2026-09-13' }), [
    { name: 'Oracle', careers_url: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001', provider: 'oraclecloud', overdue: false },
  ]);
});

test('Built In: one entry per city site, category pages only', () => {
  const boards = builtinBoards({ markets: ['www.builtinla.com', 'www.builtinnyc.com'], categories: ['dev-engineering'], max_pages: 3 });
  assert.deepEqual(boards[0], {
    name: 'Built In (builtinla.com)', provider: 'builtin', enabled: true,
    builtin: { host: 'www.builtinla.com', categories: ['dev-engineering'], max_pages: 3 },
    careers_url: 'https://www.builtinla.com/jobs',
  });
  assert.ok(boards.every((b) => !('queries' in b.builtin)), 'no keyword search: robots.txt disallows it');
});

test('a source larger than the offset ceiling is capped, not requested past it', async () => {
  const { readFreehireFeed } = await import('../src/sources/freehire-feed.mjs');
  const offsets = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/jobs/facets')) {
      return new Response(JSON.stringify({ data: { facets: { source: { big: 25_000 } } } }), { status: 200 });
    }
    const offset = Number(u.searchParams.get('offset'));
    offsets.push(offset);
    // What the API actually does past its ceiling.
    if (offset >= 10_000) return new Response('bad offset', { status: 400 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    const t0 = Date.now();
    const res = await readFreehireFeed({ countries: ['us'], openWithinDays: 2, keep: (j) => j });
    const elapsed = Date.now() - t0;
    assert.equal(res.capped, true, 'the gap is reported as incomplete coverage');
    assert.equal(offsets.some((o) => o >= 10_000), false, 'no request is made past the ceiling');
    // No x-ratelimit-remaining header here: an unknown budget must not pace.
    assert.ok(elapsed < 5_000, `${offsets.length} responses without rate-limit headers took ${elapsed}ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 2026-09-18: a capped run never recorded coveredThrough, so the checkpoint
// never moved and every run re-read the 30-day bootstrap window — 185k rows,
// 1,864 requests, 14 minutes — hitting the same ceiling each time.
test('a capped run reports how far its ascending read got, so the next run resumes there', async () => {
  const { readFreehireFeed } = await import('../src/sources/freehire-feed.mjs');
  const start = Date.parse('2026-08-17T00:00:00Z');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/jobs/facets')) {
      // One source over the ceiling, one well under it.
      return new Response(JSON.stringify({ data: { facets: { source: { big: 25_000, small: 300 } } } }), { status: 200 });
    }
    const offset = Number(u.searchParams.get('offset'));
    const big = u.searchParams.getAll('source').includes('big');
    // Ascending created_at: one minute per row, the small source ends earliest.
    const data = Array.from({ length: 100 }, (_, k) => ({
      source: big ? 'big' : 'small', url: `https://x.test/${big ? 'b' : 's'}${offset + k}`,
      title: 'ML Engineer', company: 'Acme', location: 'SF',
      created_at: new Date(start + (offset + k) * 60_000).toISOString(),
    }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  try {
    const res = await readFreehireFeed({ countries: ['us'], openWithinDays: 32, keep: () => [] });
    assert.equal(res.capped, true);
    // The big group's last permitted page is offset 9,900 (9,900 + 100 is the
    // ceiling, not past it), so its ascending read ends at row 9,999.
    assert.equal(res.coveredThrough, new Date(start + 9_999 * 60_000).toISOString());
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an uncapped run leaves coveredThrough to the unit, and a capped group with no dates stays unset', async () => {
  const { readFreehireFeed } = await import('../src/sources/freehire-feed.mjs');
  const realFetch = globalThis.fetch;
  const serve = (count, dated) => async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/jobs/facets')) {
      return new Response(JSON.stringify({ data: { facets: { source: { only: count } } } }), { status: 200 });
    }
    const data = [{ source: 'only', url: `https://x.test/${u.searchParams.get('offset')}`, title: 'ML Engineer',
      company: 'Acme', location: 'SF', ...(dated ? { created_at: '2026-09-01T00:00:00Z' } : {}) }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  try {
    globalThis.fetch = serve(300, true);
    const small = await readFreehireFeed({ countries: ['us'], keep: () => [] });
    assert.equal(small.capped, false);
    assert.equal(small.coveredThrough, null, 'a complete unit takes requestedUntil on its own');

    globalThis.fetch = serve(25_000, false);
    const undated = await readFreehireFeed({ countries: ['us'], keep: () => [] });
    assert.equal(undated.capped, true);
    assert.equal(undated.coveredThrough, null, 'no evidence of progress, so no checkpoint claim');
  } finally {
    globalThis.fetch = realFetch;
  }
});
