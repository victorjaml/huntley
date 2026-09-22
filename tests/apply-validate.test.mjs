import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'huntley-apply-'));
process.env.HUNTLEY_DATA_DIR = root;
process.env.HUNTLEY_CONFIG_DIR = join(root, 'config');
const { PATHS, ensureDirs } = await import('../src/lib/paths.mjs');
assert.ok(PATHS.preferences.startsWith(root), `refusing to run: PATHS points at ${PATHS.preferences}`);
ensureDirs();
mkdirSync(PATHS.config, { recursive: true });
const { applyProposal } = await import('../src/memory/apply.mjs');

test('an applied proposal leaves preferences that the next run can load', () => {
  writeFileSync(PATHS.preferences, 'targets:\n  title_keywords:\n    ml:\n      - research\nlocation:\n  allow:\n    - California\n');
  applyProposal({ id: 'p-empty', changes: [{ op: 'remove_list_item', path: 'targets.title_keywords.ml', value: 'research' }] });
  assert.match(readFileSync(PATHS.preferences, 'utf8'), /ml: \[\]/);
});

test('a proposal that would leave preferences invalid writes nothing', () => {
  const before = 'targets:\n  role_terms:\n    - engineer*\nlocation:\n  allow: [California]\n';
  writeFileSync(PATHS.preferences, before);
  // Parses as YAML, but config validation rejects it: allow must be a list.
  assert.throws(() => applyProposal({ id: 'p-bad', changes: [{ op: 'set_scalar', path: 'location.allow', value: 'nowhere' }] }), /invalid — nothing was written/);
  assert.equal(readFileSync(PATHS.preferences, 'utf8'), before);
  assert.ok(existsSync(join(PATHS.proposals, 'preferences.before-p-bad.yml')), 'the backup was still taken');
});
