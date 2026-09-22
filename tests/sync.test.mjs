import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PATHS resolves at import time: scratch directories first, and a sheet URL
// that is set, so .env cannot supply a real one.
const root = mkdtempSync(join(tmpdir(), 'huntley-sync-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
process.env.HUNTLEY_SHEET_CSV_URL = 'https://sheet.test/pub?output=csv';

const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
assert.ok(PATHS.data.startsWith(root), `refusing to run: PATHS points at ${PATHS.data}`);
ensureDirs();
const { syncTracker, runSync, sheetDate, loadTrackerSnapshot } = await import('../src/sheet/sync.mjs');
const { gatherEvidence } = await import('../src/weekly.mjs');

const config = { sheet: { gids: { applications: '1', inbox: '2', approvals: '3' } } };
const TABS = { 1: 'applications', 2: 'inbox', 3: 'approvals' };

/** Serve each tab's CSV by gid; a tab mapped to a number fails with that HTTP status. */
async function withSheet(tabs, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = tabs[TABS[new URL(url).searchParams.get('gid')]];
    return typeof body === 'number' ? new Response('', { status: body }) : new Response(body ?? '', { status: 200 });
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const INBOX = 'added_at,job_id,company,title,url,status\n9/14/2026 10:32:05,job-1,Acme,Research Engineer,https://x.test/1,added\n';
const APPS = 'added_at,job_id,company,title,url,location,source,status\n';

test('sheet dates in any common spreadsheet format become ISO dates', () => {
  assert.equal(sheetDate('2026-09-14T10:32:05.000Z'), '2026-09-14');
  assert.equal(sheetDate('9/14/2026 10:32:05'), '2026-09-14');
  assert.equal(sheetDate('09/14/2026'), '2026-09-14');
  assert.equal(sheetDate('14/09/2026'), '2026-09-14', 'a first number above 12 cannot be a month');
  assert.equal(sheetDate('2026/9/4'), '2026-09-04');
  assert.equal(sheetDate(''), null);
  assert.equal(sheetDate('not a date'), null);
});

test('a tab that fails keeps its last good copy, and the sync says it is degraded', async () => {
  await withSheet({ applications: APPS, inbox: INBOX, approvals: 'approved_at,proposal_id,status\n' }, () => syncTracker(config));
  assert.equal(loadTrackerSnapshot().inbox.length, 1);

  const res = await withSheet({ applications: APPS, inbox: 500, approvals: 'approved_at,proposal_id,status\n' }, () => syncTracker(config));
  assert.match(res.degraded, /could not read inbox/);
  assert.equal(loadTrackerSnapshot().inbox.length, 1, 'the outage did not erase what you added');
  assert.equal(loadTrackerSnapshot().inbox[0].job_id, 'job-1');

  const exit = await withSheet({ applications: 500, inbox: 500, approvals: 500 }, () => runSync(config));
  assert.equal(exit, 1, '`huntley sync` exits non-zero when it could not read the sheet');
  assert.equal(loadTrackerSnapshot().inbox.length, 1);
});

test('a dry-run sync reads the sheet but writes and applies nothing', async () => {
  const snapshot = join(PATHS.data, 'tracker.json');
  const before = readFileSync(snapshot, 'utf8');
  mkdirSync(PATHS.proposals, { recursive: true });
  writeFileSync(join(PATHS.proposals, 'p-dry.json'), JSON.stringify({ id: 'p-dry', changes: [{ op: 'add_note', value: 'x' }] }));
  const res = await withSheet({
    applications: APPS, inbox: INBOX + 'x,job-2,Beta,ML Engineer,https://x.test/2,added\n',
    approvals: 'approved_at,proposal_id,status\n9/14/2026,p-dry,approved\n',
  }, () => syncTracker(config, { dryRun: true }));
  assert.equal(res.pending, 1);
  assert.equal(res.applied, 0);
  assert.equal(readFileSync(snapshot, 'utf8'), before, 'the snapshot is unchanged');
  assert.equal(existsSync(join(PATHS.proposals, 'applied.jsonl')), false, 'no approval was recorded as applied');
});

test('the weekly review counts only roles that were in the email, and reads sheet dates properly', () => {
  const today = new Date().toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(join(PATHS.runs, `${today}-shown.json`), JSON.stringify({
    date: today,
    shown: [
      { id: 'job-1', title: 'Research Engineer', company: 'Acme', inEmail: true },
      { id: 'job-3', title: 'ML Engineer', company: 'Gamma', inEmail: false },   // below the threshold
      { id: 'job-4', title: 'Staff Engineer', company: 'Delta', inEmail: false }, // past the row limit
    ],
    rejected: [],
  }));
  writeFileSync(join(PATHS.data, 'tracker.json'), JSON.stringify({
    applications: [], approvals: [],
    inbox: [{ added_at: `${m}/${d}/${y} 10:32:05`, job_id: 'job-1', status: 'added' }],
  }));

  const evidence = gatherEvidence({ weekly: { lookback_days: 28 } });
  assert.deepEqual(evidence.shown.map((j) => j.id), ['job-1'], 'roles never mailed are not "shown"');
  assert.deepEqual(evidence.ignoredJobs, [], 'and so not "ignored"');
  assert.equal(evidence.added.length, 1, `a recent addition written as "${m}/${d}/${y}" is inside the window`);
  assert.deepEqual(evidence.addedJobs.map((j) => j.id), ['job-1']);
});

test('without gids only the published Inbox is read, never re-read as applications or approvals', async () => {
  const urls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(url); return new Response(INBOX, { status: 200 }); };
  try {
    const { readSheet } = await import('../src/sheet/sync.mjs');
    const sheet = await readSheet({ sheet: {} });
    assert.equal(urls.length, 1, 'one fetch, for the Inbox');
    assert.equal(sheet.inbox.length, 1);
    assert.equal(sheet.approvals, undefined, 'Inbox rows are not approvals');
    assert.equal(sheet.applications, undefined);
    assert.deepEqual(sheet.unconfigured, ['applications', 'approvals']);
  } finally {
    globalThis.fetch = real;
  }
});

test('`weekly --apply <id>` applies a stored proposal through the approval ledger, once', async () => {
  const { runWeekly } = await import('../src/weekly.mjs');
  mkdirSync(PATHS.config, { recursive: true });
  writeFileSync(PATHS.preferences, 'targets:\n  exclude_titles:\n    - intern\nnotes: []\n');
  writeFileSync(join(PATHS.proposals, 'p-hand.json'), JSON.stringify({
    id: 'p-hand', changes: [{ op: 'add_list_item', path: 'targets.exclude_titles', value: 'sales' }],
  }));

  assert.equal(await runWeekly({}, { apply: true, positional: ['p-hand'], dryRun: true }), 0);
  assert.doesNotMatch(readFileSync(PATHS.preferences, 'utf8'), /sales/, 'a dry run shows the change and applies nothing');

  assert.equal(await runWeekly({}, { apply: true, positional: ['p-hand'] }), 0);
  assert.match(readFileSync(PATHS.preferences, 'utf8'), /- sales/);
  assert.match(readFileSync(join(PATHS.proposals, 'applied.jsonl'), 'utf8'), /p-hand/);

  assert.equal(await runWeekly({}, { apply: true, positional: ['p-hand'] }), 1, 'already applied');
  assert.equal(await runWeekly({}, { apply: true, positional: ['p-nope'] }), 1, 'unknown proposal');
  assert.equal(await runWeekly({}, { apply: true, positional: [] }), 2, 'no id');
});
