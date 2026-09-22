import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const root = mkdtempSync(join(tmpdir(), 'huntley-handoff-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
mkdirSync(join(root, 'config'), { recursive: true });

const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
ensureDirs();
assert.ok(PATHS.data.startsWith(root));

test('askCli kills process groups and returns within the cleanup bound', async () => {
  const { askCli, CLEANUP_ALLOWANCE_MS } = await import('../src/rank/llm.mjs');
  const candidate = {
    bin: process.execPath,
    args: () => [join(REPO, 'tests/fixtures/bin/hanging-cli.mjs')],
  };
  const started = Date.now();
  const res = await askCli(candidate, 'ignored', {
    timeoutMs: 40,
    cleanupAllowanceMs: CLEANUP_ALLOWANCE_MS,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'timeout');
  assert.ok(
    elapsed < CLEANUP_ALLOWANCE_MS + 1_500,
    `expected return within cleanup bound, took ${elapsed}ms`,
  );
});

test('Ashby provider description survives scanBoards → prompt', async () => {
  const ashby = JSON.parse(readFileSync(join(HERE, 'fixtures/providers/ashby-list.json'), 'utf8'));
  const job = ashby.jobs[0];
  const { scanBoards } = await import('../src/sources/boards/collect.mjs');
  const http = {
    fetchJson: async () => ashby,
    fetchText: async () => '',
    fetchTextHead: async () => '',
  };
  const { jobs } = await scanBoards([{
    name: 'Acme',
    careers_url: 'https://jobs.ashbyhq.com/acme',
    provider: 'ashby',
  }], {
    lane: 'watchlist',
    prefs: { targets: { role_terms: ['engineer'], exclude_titles: [] } },
    http,
    dryRun: true,
    previewRoot: join(root, 'preview-ashby'),
    concurrency: 1,
    today: '2026-09-14',
  });
  const hit = jobs.find((j) => j.url.includes('555566667777'));
  assert.ok(hit, 'ashby job collected');
  assert.match(hit.description, /Qualifications|ranking systems/i);

  const { buildPrompt } = await import('../src/rank/prompt.mjs');
  const prompt = buildPrompt([{ ...hit, id: 'abc123def456', workplace: 'office', titleKeywords: ['research'] }], {
    prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'Ranking systems.' } },
  });
  assert.match(prompt, /ranking systems/i);
});

test('Lever provider concatenates lists through collection → enrichment skip → prompt', async () => {
  const { formatLeverDescription } = await import('../src/sources/boards/providers/lever.mjs');
  const lever = JSON.parse(readFileSync(join(HERE, 'fixtures/providers/lever-list.json'), 'utf8'));
  const posting = lever[0];
  const description = formatLeverDescription(posting);
  assert.match(description, /Introduction about the company/);
  assert.match(description, /Qualifications/);
  assert.match(description, /Ranking systems/);
  assert.match(description, /Evaluation harnesses/);

  const introOnly = posting.descriptionPlain;
  assert.ok(!/Ranking systems/i.test(introOnly), 'fixture intro alone must lack qualifications');

  const { scanBoards } = await import('../src/sources/boards/collect.mjs');
  const http = {
    fetchJson: async () => lever,
    fetchText: async () => '',
    fetchTextHead: async () => '',
  };
  const { jobs } = await scanBoards([{
    name: 'Acme',
    careers_url: 'https://jobs.lever.co/acme',
    provider: 'lever',
  }], {
    lane: 'watchlist',
    prefs: { targets: { role_terms: ['engineer'], exclude_titles: [] } },
    http,
    dryRun: true,
    previewRoot: join(root, 'preview-lever'),
    concurrency: 1,
    today: '2026-09-14',
  });
  const hit = jobs.find((j) => j.url.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  assert.ok(hit, 'Lever job collected');
  assert.match(hit.description, /Ranking systems/);

  const { enrichDescriptions } = await import('../src/sources/enrichment.mjs');
  let fetched = 0;
  const { jobs: enriched, telemetry } = await enrichDescriptions([hit], {
    enabled: true,
    max_jobs: 10,
    concurrency: 1,
    request_timeout_ms: 1000,
    total_timeout_ms: 5000,
    cache_ttl_hours: 24,
  }, {
    maxLlm: null,
    fetchImpl: async () => {
      fetched++;
      throw new Error('enrichment must not fetch when provider description is present');
    },
  });
  assert.equal(fetched, 0);
  assert.ok(telemetry.skippedExisting >= 1);
  assert.match(enriched[0].description, /Ranking systems/);
  assert.match(enriched[0].description, /Evaluation harnesses/);

  const { buildPrompt } = await import('../src/rank/prompt.mjs');
  const prompt = buildPrompt([{
    ...enriched[0],
    id: 'leverabcdef12',
    workplace: 'office',
    titleKeywords: ['research'],
  }], {
    prefs: { targets: { role_terms: ['engineer'] }, background: { summary: 'Ranking systems.' } },
  });
  assert.match(prompt, /Ranking systems/i);
  assert.match(prompt, /Evaluation harnesses/i);
});

test('long Greenhouse description keeps qualifications through scanBoards → excerpt', async () => {
  const { scanBoards } = await import('../src/sources/boards/collect.mjs');
  const { excerptDescription } = await import('../src/rank/excerpt.mjs');
  const { contentToText } = await import('../src/sources/boards/providers/greenhouse.mjs');

  const intro = 'About us. We build things. '.repeat(180);
  assert.ok(intro.length > 4000, `intro must exceed the old 4k compact cap (${intro.length})`);
  // Entity-escaped markup, as Greenhouse's boards-api often ships it.
  const content = `&lt;p&gt;${intro}&lt;/p&gt;&lt;h3&gt;Qualifications&lt;/h3&gt;&lt;p&gt;Must know PyTorch and ranking systems end to end.&lt;/p&gt;`;

  const converted = contentToText(content);
  assert.ok(converted.length > 4000, `description mode must not cut at 4k (${converted.length})`);
  assert.match(converted, /PyTorch/);
  assert.match(converted, /\n/);

  const { jobs } = await scanBoards([{
    name: 'Acme',
    careers_url: 'https://job-boards.greenhouse.io/acme',
    provider: 'greenhouse',
  }], {
    lane: 'watchlist',
    stateRoot: join(root, 'longdesc'),
    previewRoot: join(root, 'longdesc-preview'),
    dryRun: true,
    concurrency: 1,
    today: '2026-09-14',
    timeoutMs: null,
    prefs: {},
    http: {
      fetchJson: async () => ({
        jobs: [{
          id: 99,
          title: 'Research Engineer',
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/99',
          location: { name: 'San Francisco' },
          content,
          first_published: '2026-09-10T00:00:00.000Z',
        }],
      }),
      fetchText: async () => '',
      fetchTextHead: async () => '',
    },
  });

  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].description.length > 4000);
  assert.match(jobs[0].description, /PyTorch/);
  assert.match(jobs[0].description, /\n/);
  assert.match(excerptDescription(jobs[0].description), /PyTorch|Qualifications/i);
});
