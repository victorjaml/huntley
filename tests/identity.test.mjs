import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCompanyIdentity, boardUrlFor } from '../src/identity.mjs';

const job = (o) => ({ title: 'MTS', url: 'https://example.test/1', ...o });

test('the board is read from the posting URL when the lane recorded none', () => {
  assert.equal(
    boardUrlFor(job({ url: 'https://jobs.ashbyhq.com/reflectionai/2c2b06f0' })),
    'https://jobs.ashbyhq.com/reflectionai',
  );
  assert.equal(boardUrlFor(job({ board: { careers_url: 'https://job-boards.greenhouse.io/Acme/' } })),
    'https://job-boards.greenhouse.io/acme', 'trailing slash and case do not make a second board');
  assert.equal(boardUrlFor(job({ url: 'https://linkedin.com/jobs/view/mts-at-reflection-4354778255' })), null);
});

// Shipped 2026-09-15: five Reflection AI roles reached the digest under a cap
// of three, because LinkedIn calls the company "Reflection" and the watchlist
// calls it "Reflection AI".
test('one employer under several lane names resolves to one company', () => {
  const jobs = [
    job({ company: 'Reflection AI', companyKey: 'reflection ai', source: 'watchlist',
      url: 'https://jobs.ashbyhq.com/reflectionai/aaa' }),
    job({ company: 'Reflection', companyKey: 'reflection', source: 'ats_sweep',
      url: 'https://jobs.ashbyhq.com/reflectionai/bbb',
      board: { careers_url: 'https://jobs.ashbyhq.com/reflectionai' },
      companyAliases: ['reflectionai', 'Reflection'] }),
    // No board at all: LinkedIn only ever gives its own URL. It resolves
    // because some other posting tied the name "Reflection" to that board.
    job({ company: 'Reflection', companyKey: 'reflection', source: 'linkedin',
      url: 'https://linkedin.com/jobs/view/mts-safety-at-reflection-4354778255' }),
  ];
  const id = buildCompanyIdentity(jobs, {
    watchlist: [{ name: 'Reflection AI', careers_url: 'https://jobs.ashbyhq.com/reflectionai' }],
  });
  const out = id.apply(jobs);
  assert.deepEqual([...new Set(out.map((j) => j.companyKey))], ['reflection ai']);
  assert.deepEqual([...new Set(out.map((j) => j.company))], ['Reflection AI'],
    'the watchlist spelling wins, so the digest reads consistently');
});

// Autodesk and Fiserv both carry the Workday path segment "ext" as a company
// alias. Bridging two boards on that merged Autodesk into Fiserv.
test('a vendor path segment shared by two boards does not merge their companies', () => {
  const jobs = [
    job({ company: 'Autodesk Inc.', companyKey: 'autodesk',
      url: 'https://autodesk.wd1.myworkdayjobs.com/ext/job/SF/Engineer',
      board: { careers_url: 'https://autodesk.wd1.myworkdayjobs.com/ext' },
      companyAliases: ['autodesk', 'Autodesk Inc.', 'Ext'] }),
    job({ company: 'Fiserv Solutions LLC', companyKey: 'fiserv',
      url: 'https://fiserv.wd5.myworkdayjobs.com/ext/job/Sunnyvale/Manager',
      board: { careers_url: 'https://fiserv.wd5.myworkdayjobs.com/ext' },
      companyAliases: ['fiserv', 'Fiserv Solutions LLC', 'EXT'] }),
  ];
  const out = buildCompanyIdentity(jobs).apply(jobs);
  assert.equal(new Set(out.map((j) => j.companyKey)).size, 2, 'two employers stay two employers');
});

// 566 postings on job-boards.greenhouse.io/anthropic arrived labelled "Cargo".
test('the board slug outvotes a row count when naming the employer', () => {
  const jobs = [
    ...Array.from({ length: 40 }, (_, i) => job({
      company: 'Anthropic', companyKey: 'anthropic',
      url: `https://job-boards.greenhouse.io/anthropic/jobs/${i}`,
    })),
    ...Array.from({ length: 500 }, (_, i) => job({
      company: 'Cargo', companyKey: 'cargo',
      url: `https://job-boards.greenhouse.io/anthropic/jobs/9${i}`,
    })),
  ];
  const out = buildCompanyIdentity(jobs).apply(jobs);
  assert.deepEqual([...new Set(out.map((j) => j.company))], ['Anthropic']);
});

test('names alone never merge — only evidence does', () => {
  const jobs = [
    job({ company: 'Glean', companyKey: 'glean', url: 'https://job-boards.greenhouse.io/glean/jobs/1' }),
    job({ company: 'Glean AI', companyKey: 'glean ai', url: 'https://job-boards.greenhouse.io/gleanai/jobs/1' }),
  ];
  const out = buildCompanyIdentity(jobs).apply(jobs);
  assert.equal(new Set(out.map((j) => j.companyKey)).size, 2,
    'two similar names on two boards are two companies');
});

test('an aggregator board that names many companies is not treated as one employer', () => {
  const jobs = Array.from({ length: 20 }, (_, i) => job({
    company: `Company ${i}`, companyKey: `company ${i}`,
    url: `https://jobs.aggregator.test/board/jobs/${i}`,
    board: { careers_url: 'https://jobs.aggregator.test/board' },
  }));
  const out = buildCompanyIdentity(jobs).apply(jobs);
  assert.equal(new Set(out.map((j) => j.companyKey)).size, 20);
});

test('a posting with no company survives resolution untouched', () => {
  const jobs = [job({ company: '', companyKey: '' }), job({ company: undefined })];
  const out = buildCompanyIdentity(jobs).apply(jobs);
  assert.equal(out.length, 2);
});

// The pending stage builds [ ...roles carried over from the store, ...this
// run's haul ], so the posting that needs resolving is seen before the one
// carrying the evidence that resolves it.
test('evidence resolves a posting that was seen before it', () => {
  const linkedin = job({ company: 'Reflection', companyKey: 'reflection', source: 'linkedin',
    url: 'https://linkedin.com/jobs/view/mts-at-reflection-4354778255' });
  const onBoard = job({ company: 'Reflection', companyKey: 'reflection', source: 'ats_sweep',
    url: 'https://jobs.ashbyhq.com/reflectionai/bbb',
    board: { careers_url: 'https://jobs.ashbyhq.com/reflectionai' } });
  const watchlist = [{ name: 'Reflection AI', careers_url: 'https://jobs.ashbyhq.com/reflectionai' }];

  for (const order of [[linkedin, onBoard], [onBoard, linkedin]]) {
    const out = buildCompanyIdentity(order, { watchlist }).apply(order);
    assert.deepEqual([...new Set(out.map((j) => j.companyKey))], ['reflection ai'],
      'resolution does not depend on which posting arrived first');
  }
});

// 2026-09-18: two days after the fix, nothing in the run tied LinkedIn's
// "Reflection" to the Ashby board — the rows that had were one-off recovered
// observations — and Reflection AI split in two again. The board-name cache
// remembers what the board calls itself.
test('the board-name cache ties a lane name to its board when no posting does', () => {
  const jobs = [
    job({ company: 'Reflection AI', companyKey: 'reflection ai', source: 'watchlist',
      url: 'https://jobs.ashbyhq.com/reflectionai/aaa' }),
    job({ company: 'Reflection', companyKey: 'reflection', source: 'linkedin',
      url: 'https://linkedin.com/jobs/view/mts-at-reflection-4354778255' }),
  ];
  const watchlist = [{ name: 'Reflection AI', careers_url: 'https://jobs.ashbyhq.com/reflectionai' }];
  const boardNames = { 'https://jobs.ashbyhq.com/reflectionai': { name: 'Reflection', aliases: ['Reflection'] } };

  const without = buildCompanyIdentity(jobs, { watchlist }).apply(jobs);
  assert.equal(new Set(without.map((j) => j.companyKey)).size, 2, 'postings alone cannot join them');
  const out = buildCompanyIdentity(jobs, { watchlist, boardNames }).apply(jobs);
  assert.deepEqual([...new Set(out.map((j) => j.company))], ['Reflection AI']);
});

// 31 postings on Adobe's own Workday board arrived labelled "Frame.io".
test('a board naming its own employer outvotes a mislabelled row count', () => {
  const board = 'https://adobe.wd5.myworkdayjobs.com/external_experienced';
  const jobs = [
    ...Array.from({ length: 31 }, (_, i) => job({ company: 'Frame.io', companyKey: 'frame io',
      url: `${board}/job/SF/Engineer_R${i}`, board: { careers_url: board } })),
    ...Array.from({ length: 6 }, (_, i) => job({ company: 'Adobe', companyKey: 'adobe',
      url: `${board}/job/SJ/Manager_R9${i}`, board: { careers_url: board } })),
  ];
  const boardNames = { [board]: { name: 'Adobe Inc.', aliases: ['Adobe Inc.'] } };
  const out = buildCompanyIdentity(jobs, { boardNames }).apply(jobs);
  assert.deepEqual([...new Set(out.map((j) => j.company))], ['Adobe']);
});

test('a cached name for a board nobody posted on this run changes nothing', () => {
  const jobs = [job({ company: 'Acme', companyKey: 'acme', url: 'https://job-boards.greenhouse.io/acme/jobs/1' })];
  const boardNames = { 'https://job-boards.greenhouse.io/other': { name: 'Acme', aliases: [] } };
  const out = buildCompanyIdentity(jobs, { boardNames }).apply(jobs);
  assert.deepEqual(out, jobs);
});
