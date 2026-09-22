import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { datasetJobs, datasetBoard, datasetAgeHours } from '../src/sources/ats-dataset.mjs';
import { resolveCompanyNames, workdayDetailApi, workdaySiteName, workdayOrgName } from '../src/sources/board-names.mjs';
import { recordActiveBoards, activeBoards } from '../src/sources/active-boards.mjs';
import { prefilter } from '../src/rank/prefilter.mjs';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const row = (o) => ({ title: 'ML Engineer', url: 'https://job-boards.greenhouse.io/acme/jobs/1', company: 'acme', ats: 'Greenhouse', location: 'San Francisco, CA', first_seen: '2026-09-12T10:00:00Z', ...o });

// ── The dataset ──────────────────────────────────────────────────────

test('only roles first seen in the window, from the ATSes asked for', () => {
  const jobs = datasetJobs([
    row({}),
    row({ url: 'https://job-boards.greenhouse.io/acme/jobs/2', first_seen: '2026-08-01T00:00:00Z' }),
    row({ url: 'https://careers-x.icims.com/jobs/3/job', ats: 'iCIMS', company: 'x' }),
    { title: 'no url' },
  ], { since: NOW - 3 * 86_400_000, ats: new Set(['greenhouse']) });
  assert.deepEqual(jobs.map((j) => j.url), ['https://job-boards.greenhouse.io/acme/jobs/1']);
  assert.equal(jobs[0].postedAt, '2026-09-12');
  assert.equal(jobs[0].companySlug, true);
});

test('the board comes from the ATS and slug, not the URL, which may be the company\'s own domain', () => {
  assert.equal(datasetBoard(row({ url: 'https://wayve.firststage.co/jobs?gh_jid=879', company: 'wayve' })).careers_url, 'https://job-boards.greenhouse.io/wayve');
  assert.equal(datasetBoard(row({ ats: 'Workday', company: 'ngc', url: 'https://ngc.wd1.myworkdayjobs.com/Northrop_Site/job/CA/Engineer_R1' })).careers_url, 'https://ngc.wd1.myworkdayjobs.com/Northrop_Site');
});

test('Paylocity companies are names already', () => {
  const [j] = datasetJobs([row({ ats: 'Paylocity', company: 'R.F. MacDonald Co.', url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1' })], { since: 0 });
  assert.equal(j.companySlug, undefined);
});

test('undated dataset rows are kept with uncertain provenance rather than dropped', () => {
  const jobs = datasetJobs([
    row({ url: 'https://job-boards.greenhouse.io/acme/jobs/9', first_seen: null }),
    row({ url: 'https://job-boards.greenhouse.io/acme/jobs/10', first_seen: 'not-a-date' }),
  ], { since: NOW - 3 * 86_400_000, ats: new Set(['greenhouse']) });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].timestampProvenance.uncertain, true);
  assert.equal(jobs[1].firstSeenUpstream, null);
});

test('dataset age', () => {
  assert.equal(datasetAgeHours({ last_updated: '2026-09-13T00:00:00Z' }, NOW), 12);
  assert.equal(datasetAgeHours({}, NOW), Infinity);
});

// ── Company names ────────────────────────────────────────────────────

test('Workday names: the job detail API, organisation codes, and site names', () => {
  assert.equal(workdayDetailApi('https://ngc.wd1.myworkdayjobs.com/en-US/Northrop_Site/job/CA-Redondo/GNC-Engineer_R1'),
    'https://ngc.wd1.myworkdayjobs.com/wday/cxs/ngc/Northrop_Site/job/CA-Redondo/GNC-Engineer_R1');
  assert.equal(workdayDetailApi('https://example.com/job/1'), null);
  assert.equal(workdaySiteName('Northrop_Grumman_External_Site'), 'Northrop Grumman');
  assert.equal(workdaySiteName('NVIDIAExternalCareerSite'), 'NVIDIA');
  assert.equal(workdaySiteName('external'), null);
  assert.equal(workdayOrgName('2100 NVIDIA USA'), 'NVIDIA USA');
  assert.equal(workdayOrgName('ADUS-Adobe Inc.'), 'Adobe Inc.');
  assert.equal(workdayOrgName('0090 CORP-Corporate Office'), null);
});

function fakeHttp(routes) {
  const calls = [];
  const get = (url) => { calls.push(url); if (!(url in routes)) throw Object.assign(new Error('HTTP 404'), { status: 404 }); return routes[url]; };
  return { calls, fetchJson: async (u) => get(u), fetchTextHead: async (u) => get(u) };
}

test('slug names are replaced from each board, once per board, and cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-names-'));
  const ngcUrl = 'https://ngc.wd1.myworkdayjobs.com/northrop_grumman_external_site/job/CA/GNC-Engineer_R1';
  const http = fakeHttp({
    'https://boards-api.greenhouse.io/v1/boards/didi': { name: 'DiDi Labs' },
    [workdayDetailApi(ngcUrl)]: {
      hiringOrganization: { name: '0090 CORP-Corporate Office' },
      jobPostingInfo: { externalUrl: 'https://ngc.wd1.myworkdayjobs.com/Northrop_Grumman_External_Site/job/CA/GNC-Engineer_R1' },
    },
    'https://jobs.ashbyhq.com/plaid': '<html><title>Plaid Jobs</title>',
  });
  const jobs = datasetJobs([
    row({ company: 'didi', url: 'https://job-boards.greenhouse.io/didi/jobs/1' }),
    row({ company: 'didi', url: 'https://job-boards.greenhouse.io/didi/jobs/2' }),
    row({ ats: 'Workday', company: 'ngc', url: ngcUrl }),
    row({ ats: 'Ashby', company: 'plaid', url: 'https://jobs.ashbyhq.com/plaid/abc' }),
  ], { since: 0 });
  const cachePath = join(dir, 'names.json');
  await resolveCompanyNames(jobs, { http, cachePath });
  assert.deepEqual(jobs.map((j) => j.company), ['DiDi Labs', 'DiDi Labs', 'Northrop Grumman', 'Plaid']);
  assert.equal(http.calls.filter((u) => u.includes('greenhouse')).length, 1, 'one lookup per board');

  // The block list sees every name the board goes by.
  const prefs = { filters: { block_companies: ['Northrop Grumman'] }, targets: {}, location: {} };
  assert.deepEqual(prefilter(jobs, prefs).rejected.map((r) => r.job.company), ['Northrop Grumman']);

  const again = datasetJobs([row({ company: 'didi', url: 'https://job-boards.greenhouse.io/didi/jobs/3' })], { since: 0 });
  http.calls.length = 0;
  await resolveCompanyNames(again, { http, cachePath });
  assert.equal(again[0].company, 'DiDi Labs');
  assert.equal(http.calls.length, 0, 'served from cache');
});

test('a block list entry matches a run-together name, but a short one does not match inside words', () => {
  const prefs = { filters: { block_companies: ['Scale AI', 'xAI'] }, targets: {}, location: {} };
  const job = (company) => ({ id: company, url: 'https://x.test/1', title: 'ML Engineer', company, location: 'San Francisco, CA' });
  const { rejected, kept } = prefilter([job('scaleai'), job('Maxaid Labs')], prefs);
  assert.deepEqual(rejected.map((r) => r.job.company), ['scaleai']);
  assert.deepEqual(kept.map((j) => j.company), ['Maxaid Labs']);
});

// ── Active boards ────────────────────────────────────────────────────

test('boards that produce passing roles become active, and age out', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'huntley-active-')), 'active.json');
  const gh = { url: 'https://job-boards.greenhouse.io/didi/jobs/1', company: 'didi', companySlug: true };
  assert.equal(recordActiveBoards([gh, { ...gh, url: 'https://job-boards.greenhouse.io/didi/jobs/2' }], { path, date: '2026-06-01' }), 1);
  recordActiveBoards([{ url: 'https://job-boards.greenhouse.io/didi/jobs/3', company: 'DiDi Labs' }], { path, date: '2026-06-02' });
  recordActiveBoards([{ url: 'https://jobs.lever.co/acme/1', company: 'Acme' }], { path, date: '2026-09-10' });

  assert.deepEqual(activeBoards({ path, today: '2026-09-13', withinDays: 120 }), [
    { name: 'DiDi Labs', careers_url: 'https://job-boards.greenhouse.io/didi', overdue: false },
    { name: 'Acme', careers_url: 'https://jobs.lever.co/acme', overdue: false },
  ]);
  const listed90 = activeBoards({ path, today: '2026-09-13', withinDays: 90 });
  assert.equal(listed90.find((b) => b.name === 'DiDi Labs')?.overdue, true);
  assert.equal(listed90.find((b) => b.name === 'Acme')?.overdue, false);
  const { evictInactiveBoards, markActiveBoardsScanned } = await import('../src/sources/active-boards.mjs');
  markActiveBoardsScanned({ path, urls: ['https://job-boards.greenhouse.io/didi'], date: '2026-09-12' });
  evictInactiveBoards({ path, today: '2026-09-13', withinDays: 90, scanned: listed90.map((b) => b.careers_url) });
  assert.deepEqual(activeBoards({ path, today: '2026-09-13', withinDays: 90 }).map((b) => b.name), ['Acme'], 'quiet boards evict after a prior scan while Huntley was running');
  assert.deepEqual(activeBoards({ path, today: '2026-09-13', exclude: new Set(['https://jobs.lever.co/acme']) }), []);
});

test('a catch-up after Huntley downtime does not evict overdue boards on the first scan', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'huntley-active-')), 'active.json');
  recordActiveBoards([{ url: 'https://jobs.lever.co/quiet/1', company: 'Quiet' }], { path, date: '2026-06-01' });
  const { evictInactiveBoards, markActiveBoardsScanned } = await import('../src/sources/active-boards.mjs');
  const scanned = ['https://jobs.lever.co/quiet'];
  evictInactiveBoards({ path, today: '2026-09-13', withinDays: 90, scanned });
  assert.equal(activeBoards({ path, today: '2026-09-13', withinDays: 90 }).length, 1, 'first scan after a gap keeps the board');
  markActiveBoardsScanned({ path, urls: scanned, date: '2026-09-13' });
  evictInactiveBoards({ path, today: '2026-09-14', withinDays: 90, scanned });
  assert.equal(activeBoards({ path, today: '2026-09-14', withinDays: 90 }).length, 0, 'a later run can evict after lastScan is recent');
});

test('a failed overdue board is not evicted just because it was listed', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'huntley-active-')), 'active.json');
  recordActiveBoards([{ url: 'https://jobs.lever.co/quiet/1', company: 'Quiet' }], { path, date: '2026-06-01' });
  recordActiveBoards([{ url: 'https://jobs.lever.co/ok/1', company: 'Ok' }], { path, date: '2026-09-10' });
  const { evictInactiveBoards } = await import('../src/sources/active-boards.mjs');
  const { completeUnitIdentities } = await import('../src/state/coverage.mjs');
  const { coverageUnit } = await import('../src/state/coverage.mjs');
  const scanned = completeUnitIdentities([
    coverageUnit({ key: 'active_boards:https://jobs.lever.co/ok', status: 'complete', requestedUntil: '2026-09-13T00:00:00.000Z' }),
    coverageUnit({ key: 'active_boards:https://jobs.lever.co/quiet', status: 'failed', requestedUntil: '2026-09-13T00:00:00.000Z' }),
  ], 'active_boards');
  evictInactiveBoards({ path, today: '2026-09-13', withinDays: 90, scanned });
  const remaining = activeBoards({ path, today: '2026-09-13', withinDays: 90 }).map((b) => b.careers_url).sort();
  assert.ok(remaining.some((u) => u.includes('quiet')), 'failed overdue board stays for retry');
  assert.ok(remaining.some((u) => u.includes('/ok')), 'recent success stays');
});


test('heuristic-only matches cannot activate an employer board', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'huntley-active-')), 'boards.json');
  const job = { url: 'https://jobs.lever.co/acme/1', company: 'Acme', score: 4, heuristicOnly: true };
  assert.equal(recordActiveBoards([job], { path, date: '2026-09-14' }), 0);
  assert.deepEqual(activeBoards({ path, today: '2026-09-14' }), []);
  assert.equal(recordActiveBoards([{ ...job, heuristicOnly: false }], { path, date: '2026-09-14' }), 1);
});

// ── What the lane hands downstream ───────────────────────────────────

test('the dataset lane emits only the roles that pass your filters', async () => {
  const { runDatasetLane } = await import('../src/sources/ats-lanes.mjs');
  const prefs = {
    targets: { role_terms: ['engineer'] },
    location: { cities: ['San Francisco'] },
    filters: { block_companies: ['Blocked Co'] },
  };
  // No companySlug on any row, so name resolution has nothing to look up.
  const jobs = [
    { id: 'keep', url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'ML Engineer', company: 'Acme', location: 'San Francisco, CA' },
    { id: 'blocked', url: 'https://job-boards.greenhouse.io/blocked/jobs/2', title: 'ML Engineer', company: 'Blocked Co', location: 'San Francisco, CA' },
    { id: 'wrong-title', url: 'https://job-boards.greenhouse.io/acme/jobs/3', title: 'Barista', company: 'Acme', location: 'San Francisco, CA' },
    { id: 'wrong-place', url: 'https://job-boards.greenhouse.io/acme/jobs/4', title: 'ML Engineer', company: 'Acme', location: 'Berlin, Germany' },
  ];

  const out = await runDatasetLane({
    prefs,
    warn: () => {},
    settings: { name_budget_seconds: 0 },
    downloadDatasetFn: async () => ({ jobs, total: 1_000_000, ageHours: 1, units: [] }),
  });

  assert.deepEqual(out.jobs.map((j) => j.id), ['keep'],
    'the 1.4M-row dataset must not reach raw.json or the roles store');
});
