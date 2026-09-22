import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';
import { applyChange, validateProposal } from '../src/memory/apply.mjs';

const SAMPLE = `targets:
  # The kinds of role you do.
  role_terms:
    - "engineer*"
    - "scientist*"

  # Never show these.
  exclude_titles:
    - intern
    - sales

location:
  allow:
    - Remote
    - "Los Angeles"
  block:
    - Seattle
    - Austin

filters:
  block_companies: []

notes: []
`;

const load = (t) => yaml.load(t);

test('adding a list item keeps every comment in the file', () => {
  const out = applyChange(SAMPLE, { op: 'add_list_item', path: 'targets.exclude_titles', value: 'solutions engineer' });
  assert.ok(out.includes('# Never show these.'), 'comments survive the edit');
  assert.ok(out.includes('# The kinds of role you do.'));
  assert.deepEqual(load(out).targets.exclude_titles, ['intern', 'sales', 'solutions engineer']);
  assert.deepEqual(load(out).targets.role_terms, load(SAMPLE).targets.role_terms, 'a sibling list is untouched');
});

test('adding to an empty inline list converts it to a block', () => {
  const out = applyChange(SAMPLE, { op: 'add_note', value: 'Pre-seed with no named funding has not converted.' });
  assert.deepEqual(load(out).notes, ['Pre-seed with no named funding has not converted.']);
  assert.deepEqual(load(out).filters.block_companies, [], 'the other empty list is untouched');
});

test('adding an item that is already present changes nothing', () => {
  const out = applyChange(SAMPLE, { op: 'add_list_item', path: 'location.block', value: 'Seattle' });
  assert.equal(out, SAMPLE);
});

test('removing a list item removes exactly that item', () => {
  const out = applyChange(SAMPLE, { op: 'remove_list_item', path: 'location.block', value: 'Seattle' });
  assert.deepEqual(load(out).location.block, ['Austin']);
  assert.deepEqual(load(out).location.allow, ['Remote', 'Los Angeles'], 'the sibling list is untouched');
});

test('removing something that is not there fails loudly rather than silently', () => {
  assert.throws(
    () => applyChange(SAMPLE, { op: 'remove_list_item', path: 'location.block', value: 'Denver' }),
    /not in location\.block/,
  );
});

test('values that YAML would misread are quoted', () => {
  const out = applyChange(SAMPLE, { op: 'add_list_item', path: 'targets.exclude_titles', value: 'no' });
  assert.deepEqual(load(out).targets.exclude_titles, ['intern', 'sales', 'no'], '"no" stays a string, not false');
  const out2 = applyChange(SAMPLE, { op: 'add_list_item', path: 'location.allow', value: 'Washington, DC' });
  assert.deepEqual(load(out2).location.allow, ['Remote', 'Los Angeles', 'Washington, DC']);
});

test('the weekly loop cannot propose a change outside the allowed paths', () => {
  const problems = validateProposal({
    id: 'p1',
    changes: [{ op: 'set_scalar', path: 'compensation.minimum', value: '$1' }],
  });
  assert.ok(problems.some((p) => /outside what the weekly loop may change/.test(p)));
});

test('the weekly loop cannot propose an unknown operation', () => {
  const problems = validateProposal({ id: 'p1', changes: [{ op: 'rewrite_scoring', path: 'notes', value: 'x' }] });
  assert.ok(problems.some((p) => /unknown op/.test(p)));
});

test('a proposal with no changes is refused', () => {
  assert.ok(validateProposal({ id: 'p1', changes: [] }).length > 0);
});

test('a non-empty inline list is rewritten as a block before it is edited', () => {
  const inline = 'targets:\n  exclude_titles: ["intern", "account executive"]  # never these\nfilters:\n  block_companies: []\n';
  let out = applyChange(inline, { op: 'add_list_item', path: 'targets.exclude_titles', value: 'member of technical staff' });
  assert.deepEqual(load(out).targets.exclude_titles, ['intern', 'account executive', 'member of technical staff']);
  assert.ok(out.includes('# never these'), 'the trailing comment survives');
  out = applyChange(out, { op: 'remove_list_item', path: 'targets.exclude_titles', value: 'intern' });
  assert.deepEqual(load(out).targets.exclude_titles, ['account executive', 'member of technical staff']);
  assert.deepEqual(load(applyChange(inline, { op: 'remove_list_item', path: 'targets.exclude_titles', value: 'intern' })).targets.exclude_titles, ['account executive']);
});

test('removing the last item leaves an empty list, not a null key', () => {
  const text = 'targets:\n  title_keywords:\n    ml:  # core ML\n      - research\n    safety:\n      - alignment\n';
  const out = applyChange(text, { op: 'remove_list_item', path: 'targets.title_keywords.ml', value: 'research' });
  assert.deepEqual(load(out).targets.title_keywords, { ml: [], safety: ['alignment'] });
  assert.ok(out.includes('# core ML'), 'the comment survives');
  assert.deepEqual(load(applyChange(out, { op: 'add_list_item', path: 'targets.title_keywords.ml', value: 'mlops' })).targets.title_keywords.ml, ['mlops']);
});
