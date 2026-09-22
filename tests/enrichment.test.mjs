import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'huntley-enrich-'));
process.env.HUNTLEY_DATA_DIR = root;
mkdirSync(join(root, 'cache'), { recursive: true });

const { ensureDirs } = await import('../src/lib/paths.mjs');
ensureDirs();
const { htmlToPlain, extractDescription, parseAtsTarget } = await import('../src/sources/enrichment/adapters.mjs');
const { enrichDescriptions } = await import('../src/sources/enrichment.mjs');

test('detail adapters extract Greenhouse, Lever, and Ashby plain text', () => {
  assert.match(htmlToPlain('<p>Build <b>evals</b></p>'), /Build evals/);
  assert.match(htmlToPlain('<h2>Qualifications</h2><p>Know ranking</p>'), /^Qualifications$/m);
  // Greenhouse API returns HTML-escaped content — decode before stripping.
  assert.match(
    htmlToPlain('&lt;p&gt;Build evals&lt;/p&gt;&lt;h3&gt;Qualifications&lt;/h3&gt;'),
    /^Build evals$/m,
  );
  assert.match(
    htmlToPlain('&lt;p&gt;Build evals&lt;/p&gt;&lt;h3&gt;Qualifications&lt;/h3&gt;'),
    /^Qualifications$/m,
  );
  assert.doesNotMatch(
    htmlToPlain('&lt;p&gt;Build evals&lt;/p&gt;'),
    /<p>/,
  );
  assert.match(extractDescription('greenhouse', { content: '<p>Owns ranking quality.</p>' }), /Owns ranking/);
  assert.match(extractDescription('lever', {
    descriptionPlain: 'Lever introduction about the company.',
    lists: [{ text: 'Qualifications', content: '<li>Ranking systems</li>' }],
  }), /Lever introduction[\s\S]*Ranking systems/);
  assert.match(extractDescription('ashby', {
    jobs: [{ id: 'abc', descriptionPlain: 'Ashby role description with qualifications.' }],
  }, 'abc'), /Ashby role/);
  assert.equal(parseAtsTarget('https://example.com/jobs/1'), null);
  assert.deepEqual(
    parseAtsTarget('https://www.axiomlaw.com/careers?gh_jid=8797', {
      board: { vendor: 'greenhouse', slug: 'axiomtalentplatform' },
    }),
    { vendor: 'greenhouse', org: 'axiomtalentplatform', req: '8797' },
  );
});

test('Greenhouse HTML → adapter → prompt keeps late qualifications', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { excerptDescription } = await import('../src/rank/excerpt.mjs');
  const { buildPrompt } = await import('../src/rank/prompt.mjs');

  const fixture = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/providers/greenhouse-list.json'),
    'utf8',
  ));
  const html = fixture.jobs[0].content;
  assert.ok(html.length > 4000, `fixture HTML should exceed prompt budget (${html.length})`);

  const plain = extractDescription('greenhouse', fixture.jobs[0]);
  assert.ok(plain.length > 4000, `plain text should stay long (${plain.length})`);
  assert.match(plain, /^Qualifications$/m, 'heading boundaries must survive htmlToPlain');
  assert.match(plain, /evaluation harnesses/i);

  const excerpt = excerptDescription(plain, { maxChars: 4000 });
  assert.match(excerpt, /evaluation harnesses/i);
  assert.match(excerpt, /qualifications/i);

  const prompt = buildPrompt([{
    id: 'gh101abcdefgh',
    title: 'Research Engineer',
    company: 'Acme',
    location: 'San Francisco',
    workplace: 'office',
    source: 'greenhouse',
    titleKeywords: ['research'],
    description: plain,
  }], {
    prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'Ranking systems.' } },
  });
  assert.match(prompt, /evaluation harnesses/i);
});

test('fetchAllowedJson carries one deadline across redirects and streams size limits', async () => {
  const { fetchAllowedJson } = await import('../src/sources/enrichment/adapters.mjs');
  let calls = 0;
  const started = Date.now();
  const fetchImpl = async (url) => {
    calls++;
    await new Promise((r) => setTimeout(r, 25));
    if (calls < 4) {
      return {
        status: 302,
        ok: false,
        headers: { get: (h) => (h === 'location' ? 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1' : null) },
        body: null,
        arrayBuffer: async () => Buffer.from(''),
      };
    }
    // Oversized streamed body
    const chunk = Buffer.alloc(100_000, 65);
    let n = 0;
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            async read() {
              if (n++ < 6) return { done: false, value: chunk };
              return { done: true, value: undefined };
            },
            async cancel() {},
          };
        },
      },
    };
  };

  await assert.rejects(
    () => fetchAllowedJson('https://boards-api.greenhouse.io/v1/boards/acme/jobs/1', {
      timeoutMs: 30,
      fetchImpl,
    }),
    /deadline|too many redirects|response too large|aborted/i,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `redirects must share one deadline, took ${elapsed}ms over ${calls} calls`);
});

test('enrichment fetches within budgets and leaves failures metadata-only', async () => {
  const jobs = [
    { id: '1', url: 'https://boards.greenhouse.io/acme/jobs/101', title: 'RE', company: 'Acme', description: null },
    { id: '2', url: 'https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'RE', company: 'Acme', description: null },
    { id: '3', url: 'https://www.linkedin.com/jobs/view/1', title: 'RE', company: 'Acme', description: null },
    { id: '4', url: 'https://boards.greenhouse.io/acme/jobs/102', title: 'RE', company: 'Acme', description: 'Already here' },
  ];

  const fetchImpl = async (url) => {
    if (String(url).includes('/101')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from(JSON.stringify({ content: '&lt;p&gt;Greenhouse detail about evals.&lt;/p&gt;' })),
      };
    }
    if (String(url).includes('lever')) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('{}'),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  const { jobs: out, telemetry } = await enrichDescriptions(jobs, {
    enabled: true,
    max_jobs: 10,
    concurrency: 2,
    request_timeout_ms: 1000,
    total_timeout_ms: 5000,
    cache_ttl_hours: 24,
  }, { maxLlm: null, fetchImpl });

  assert.match(out[0].description, /Greenhouse detail/);
  assert.doesNotMatch(out[0].description, /<p>/);
  assert.equal(out[0].evidenceLevel, 'description');
  assert.equal(out[1].description, null);
  assert.equal(out[1].evidenceLevel, 'metadata_only');
  assert.equal(out[2].evidenceLevel, 'metadata_only');
  assert.equal(out[3].description, 'Already here');
  assert.ok(telemetry.succeeded >= 1);
  assert.ok(telemetry.failed >= 1);
  assert.ok(telemetry.skippedUnsupported >= 1);
});

test('Ashby enrichment fetches each board once and allows multi-MB payloads', async () => {
  const { MAX_ASHBY_BOARD_BYTES } = await import('../src/sources/enrichment/adapters.mjs');
  assert.ok(MAX_ASHBY_BOARD_BYTES > 500_000);

  const jobs = [
    { id: 'a1', url: 'https://jobs.ashbyhq.com/cohere/aaaaaaaa-bbbb-cccc-dddd-111111111111', title: 'RE', company: 'Cohere', description: null },
    { id: 'a2', url: 'https://jobs.ashbyhq.com/cohere/aaaaaaaa-bbbb-cccc-dddd-222222222222', title: 'RE', company: 'Cohere', description: null },
  ];
  let boardFetches = 0;
  const big = JSON.stringify({
    jobs: [
      { id: 'aaaaaaaa-bbbb-cccc-dddd-111111111111', descriptionPlain: 'Role one about evals.' },
      { id: 'aaaaaaaa-bbbb-cccc-dddd-222222222222', descriptionPlain: 'Role two about ranking.' },
      // Pad so a naive 500 KB ceiling would fail.
      { id: 'pad', descriptionPlain: 'x'.repeat(600_000) },
    ],
  });
  assert.ok(Buffer.byteLength(big) > 500_000);

  const fetchImpl = async (url) => {
    assert.match(String(url), /ashbyhq\.com/);
    boardFetches++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(big),
    };
  };

  const { jobs: out, telemetry } = await enrichDescriptions(jobs, {
    enabled: true,
    max_jobs: 10,
    concurrency: 2,
    request_timeout_ms: 5000,
    total_timeout_ms: 10_000,
    cache_ttl_hours: 24,
  }, { maxLlm: null, fetchImpl });

  assert.equal(boardFetches, 1, 'one Ashby board download per company per run');
  assert.equal(telemetry.ashbyBoardsFetched, 1);
  assert.match(out[0].description, /Role one/);
  assert.match(out[1].description, /Role two/);
});

test('enrichment max_llm follows positional order like ranking', async () => {
  const jobs = [
    { id: 'has', url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'RE', company: 'Acme', description: 'Present' },
    { id: 'first', url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'RE', company: 'Acme', description: null },
    { id: 'second', url: 'https://boards.greenhouse.io/acme/jobs/3', title: 'RE', company: 'Acme', description: null },
  ];
  let fetched = 0;
  const fetchImpl = async (url) => {
    fetched++;
    const id = String(url).match(/jobs\/(\d+)/)?.[1];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(JSON.stringify({ content: `&lt;p&gt;Fetched ${id}&lt;/p&gt;` })),
    };
  };
  const { jobs: out, telemetry } = await enrichDescriptions(jobs, {
    enabled: true,
    max_jobs: 10,
    concurrency: 1,
    request_timeout_ms: 1000,
    total_timeout_ms: 5000,
    cache_ttl_hours: 24,
  }, {
    maxLlm: 1,
    fetchImpl,
  });
  // First slot is occupied by a role that already has a description — do not
  // enrich past ranking's positional cutoff.
  assert.equal(telemetry.skippedExisting, 1);
  assert.equal(telemetry.skippedBudget, 2);
  assert.equal(fetched, 0);
  assert.equal(out[1].description, null);
  assert.equal(out[2].description, null);
});

test('Ashby board fetch failures are remembered for the run', async () => {
  const jobs = [
    { id: 'a1', url: 'https://jobs.ashbyhq.com/huge/aaaaaaaa-bbbb-cccc-dddd-111111111111', title: 'RE', company: 'Huge', description: null },
    { id: 'a2', url: 'https://jobs.ashbyhq.com/huge/aaaaaaaa-bbbb-cccc-dddd-222222222222', title: 'RE', company: 'Huge', description: null },
  ];
  let boardFetches = 0;
  const fetchImpl = async () => {
    boardFetches++;
    throw new Error('response too large');
  };
  const { telemetry } = await enrichDescriptions(jobs, {
    enabled: true,
    max_jobs: 10,
    concurrency: 2,
    request_timeout_ms: 1000,
    total_timeout_ms: 5000,
    cache_ttl_hours: 24,
  }, { maxLlm: null, fetchImpl });
  assert.equal(boardFetches, 1, 'failed board must not be re-fetched per role');
  assert.equal(telemetry.ashbyBoardsFetched, 1);
  assert.equal(telemetry.failed, 2);
});
