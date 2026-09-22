import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProposal } from '../src/memory/propose.mjs';
import { validateProposal } from '../src/memory/apply.mjs';
import { renderProposalEmail } from '../src/digest/proposal.mjs';

// Synthetic evidence: a person who keeps adding roles from one unwatched
// company, ignores everything a "platform" keyword surfaces, and adds roles in
// a city they have blocked.
function evidence() {
  const shown = [];
  const push = (o) => shown.push({
    id: o.id, title: o.title, company: o.company, companyKey: o.company.toLowerCase(),
    location: o.location ?? 'Los Angeles, CA', score: o.score ?? 4, why: o.why ?? 'reason',
    watchlist: Boolean(o.watchlist), shownOn: '2026-09-01',
  });

  // Three adds from an unwatched company.
  for (let i = 0; i < 3; i++) push({ id: `hex${i}`, title: `ML Engineer ${i}`, company: 'Hexlab' });
  // Fourteen "platform" roles nobody added.
  for (let i = 0; i < 14; i++) push({ id: `plat${i}`, title: `Platform Engineer ${i}`, company: `Co${i}` });
  // Two adds in a blocked city.
  push({ id: 'sea1', title: 'ML Engineer', company: 'Northwind', location: 'Seattle, WA or Remote' });
  push({ id: 'sea2', title: 'Senior ML Engineer', company: 'Cascade', location: 'Remote - Seattle, WA' });

  const addedIds = new Set(['hex0', 'hex1', 'hex2', 'sea1', 'sea2']);
  return {
    days: 28,
    shown,
    rejected: [],
    added: [...addedIds].map((id) => ({ job_id: id, status: 'added', added_at: '2026-09-01' })),
    applications: [],
    outcomes: [],
    ignoredExplicitly: [],
    addedJobs: shown.filter((j) => addedIds.has(j.id)),
    ignoredJobs: shown.filter((j) => !addedIds.has(j.id)),
    addedElsewhere: [],
  };
}

const config = {
  // rank.cli is a binary that does not exist, so the LLM note pass is skipped
  // and this test exercises the deterministic detectors alone.
  rank: { cli: '__no_such_cli__', timeout_ms: 1000 },
  preferences: {
    targets: {
      role_terms: ['engineer*'],
      title_keywords: ['machine learning', 'platform', 'ml', 'infrastructure'],
      exclude_titles: ['intern'],
    },
    location: { allow: ['California'] },
    filters: {},
  },
};

test('a company you keep adding from is proposed for the watchlist', async () => {
  const p = await buildProposal(evidence(), config);
  const hit = p.changes.find((c) => /Hexlab/.test(String(c.value)));
  assert.ok(hit, 'Hexlab should be proposed');
  assert.equal(hit.op, 'add_note', 'it is a note plus a follow-up command, not a silent watchlist.yml edit');
  assert.ok(hit.followUp.includes('discover-board'), 'it tells you how to resolve the ATS board');
  assert.ok(hit.evidence.length >= 3, 'the finding carries its evidence');
});

test('a keyword that only ever surfaces roles you ignore is proposed for removal', async () => {
  const p = await buildProposal(evidence(), config);
  const hit = p.changes.find((c) => c.op === 'remove_list_item' && c.path === 'targets.title_keywords');
  assert.ok(hit, 'the dead keyword should be proposed for removal');
  assert.equal(hit.value, 'platform');
  assert.match(hit.reason, /14 roles/);
});

test('a keyword that only ever co-occurs with another is not blamed', async () => {
  // "infrastructure" appears only alongside "platform" below, so it was never
  // the sole reason a role was shown — removing it would change nothing.
  const e = evidence();
  for (let i = 0; i < 14; i++) {
    e.shown.push({ id: `infra${i}`, title: `Platform Infrastructure Engineer ${i}`, company: `In${i}`, companyKey: `in${i}`, location: 'Remote', score: 3, why: 'x', watchlist: false, shownOn: '2026-09-01' });
  }
  e.ignoredJobs = e.shown.filter((j) => !e.addedJobs.some((a) => a.id === j.id));
  const p = await buildProposal(e, config);
  assert.equal(p.changes.find((c) => c.value === 'infrastructure'), undefined);
});

test('every generated proposal passes the apply-time validator', async () => {
  const p = await buildProposal(evidence(), config);
  assert.deepEqual(validateProposal(p), [], 'a proposal huntley generates must be one it can apply');
});

test('the proposal email shows the evidence and says nothing has changed', async () => {
  const p = await buildProposal(evidence(), config);
  const { html, text } = renderProposalEmail({
    proposal: p, evidence: evidence(), date: '2026-09-11',
    approveLink: 'https://script.google.com/x/exec?a=approve', config,
  });
  assert.match(html, /Nothing has changed yet/);
  assert.match(html, /APPROVE/);
  assert.match(html, /Hexlab/, 'the evidence appears in the email, not behind a link');
  assert.match(text, /NOTHING HAS CHANGED YET/);
  assert.match(text, /APPROVE: https:\/\/script\.google\.com/);
});

test('with no findings the proposal is empty rather than invented', async () => {
  const quiet = { ...evidence(), addedJobs: [], ignoredJobs: [], added: [], shown: [] };
  const p = await buildProposal(quiet, config);
  assert.equal(p.changes.length, 0);
});
