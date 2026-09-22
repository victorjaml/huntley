import test from 'node:test';
import assert from 'node:assert/strict';

import consider from '../src/sources/boards/providers/consider.mjs';

const entry = {
  name: 'Sequoia Capital (portfolio)',
  careers_url: 'https://jobs.sequoiacap.com/jobs',
  provider: 'consider',
  consider_board: 'sequoia-capital',
};

const okBody = {
  jobs: [{
    title: 'ML Engineer',
    url: 'https://job-boards.greenhouse.io/spacex/jobs/1',
    companyName: 'SpaceX',
    locations: ['Hawthorne, CA'],
    remote: false,
    timeStamp: '2026-09-15T17:57:07Z',
  }],
};

test('the search carries the credentials the handshake produced', async () => {
  let sent = null;
  const jobs = await consider.fetch(entry, {
    _acquireHandshake: async () => ({ cookie: 'session=a; session.sig=b', csrfToken: 'tok-12345678' }),
    fetchJson: async (url, opts) => { sent = { url, opts }; return okBody; },
  });
  assert.equal(sent.opts.headers.cookie, 'session=a; session.sig=b',
    'both cookies go: Consider refuses `session` without `session.sig` exactly as it refuses neither');
  assert.equal(sent.opts.headers['x-csrf-token'], 'tok-12345678');
  assert.equal(sent.opts.redirect, 'error', 'the SSRF guard survives');
  assert.equal(jobs.length, 1);
});

// Shipped 2026-09-15: six fund boards returned nothing. The handshake ran on a
// private 8s budget outside the retry/deadline machinery; when it lapsed under
// a 572-board sweep the failure became {null, null} and the POST went out
// anyway, to be refused with a bare "HTTP 412 Precondition Failed".
test('a failed handshake fails the board by name instead of sending a doomed search', async () => {
  let posted = false;
  await assert.rejects(
    () => consider.fetch(entry, {
      _acquireHandshake: async () => ({ cookie: null, csrfToken: null }),
      fetchJson: async () => { posted = true; return okBody; },
    }),
    /handshake/i,
    'the error names the handshake, not the 412 it would have caused',
  );
  assert.equal(posted, false, 'a search with no credentials is never sent');
});

test('the handshake runs on the shared budget, not a private one', async () => {
  const seen = [];
  const ctx = {
    signal: AbortSignal.timeout(30_000),
    deadlineAt: Date.now() + 30_000,
    fetchResponse: async (url, opts) => {
      seen.push(opts);
      return new Response('<script>{"csrfToken":"tok-12345678"}</script>', {
        status: 200,
        headers: [['set-cookie', 'session=a; path=/'], ['set-cookie', 'session.sig=b; path=/']],
      });
    },
    fetchJson: async () => okBody,
  };
  await consider.fetch(entry, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, ctx.signal, 'the run-wide abort signal reaches the handshake');
  assert.equal(seen[0].deadlineAt, ctx.deadlineAt, 'so does the collection deadline');
  assert.equal(seen[0].redirect, 'error');
});

test('a handshake that fails once is retried before the board is given up on', async () => {
  let calls = 0;
  const jobs = await consider.fetch(entry, {
    sleep: async () => {},
    fetchResponse: async () => {
      if (++calls === 1) throw new Error('socket hang up');
      return new Response('<script>{"csrfToken":"tok-12345678"}</script>', {
        status: 200,
        headers: [['set-cookie', 'session=a'], ['set-cookie', 'session.sig=b']],
      });
    },
    fetchJson: async () => okBody,
  });
  assert.equal(calls, 2);
  assert.equal(jobs.length, 1);
});

test('remote roles say so, whatever the location string says', async () => {
  const jobs = await consider.fetch(entry, {
    _acquireHandshake: async () => ({ cookie: 'c=1', csrfToken: 'tok-12345678' }),
    fetchJson: async () => ({
      jobs: [
        { title: 'A', url: 'https://x.test/1', companyName: 'Attentive', locations: ['United States'], remote: true },
        { title: 'B', url: 'https://x.test/2', companyName: 'Zipline', locations: ['Dallas, TX'], remote: false },
        { title: 'C', url: 'https://x.test/3', companyName: 'Acme', locations: ['Remote, US'], remote: true },
      ],
    }),
  });
  assert.deepEqual(jobs.map((j) => j.location),
    ['United States, Remote', 'Dallas, TX', 'Remote, US'],
    'a location that already reads as remote is not given a second marker');
});
