// Applying an approved preference change.
//
// Almost the only code in huntley that writes config/preferences.yml (setup
// --cv also writes background.summary once). Four rules govern apply, and they
// are the reason the weekly loop can be trusted:
//
//   1. It runs only from an approval you clicked. Nothing calls it on a
//      schedule, and `huntley weekly` never calls it at all.
//   2. It applies exactly the changes in the stored proposal — the same object
//      that was rendered into the email you approved. It does not re-derive,
//      re-rank, or re-interpret anything at apply time.
//   3. Every apply writes a timestamped backup first, so any change is one
//      `cp` from being undone.
//   4. It edits the YAML as text, not as a parsed document. A parse-and-dump
//      round trip would silently delete every comment in the file — and that
//      file is mostly comments explaining what each list is for.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';
import { validateTargets, validateLocation } from '../config.mjs';

/**
 * A change is one of:
 *   {op: 'add_list_item',    path: 'targets.exclude_titles', value: 'sales engineer'}
 *   {op: 'remove_list_item', path: 'location.block',         value: 'Seattle'}
 *   {op: 'add_note',         value: 'Pre-seed with no named funding has not converted.'}
 *   {op: 'set_scalar',       path: 'rank.min_score',         value: 3.5}
 *
 * Deliberately small. The weekly loop cannot express "rewrite the scoring
 * system" because it is not allowed to, and a vocabulary that cannot say a
 * thing is a stronger guarantee than a rule asking it not to.
 */
const OPS = new Set(['add_list_item', 'remove_list_item', 'add_note', 'set_scalar']);

/** Paths the weekly loop may touch. Anything else is refused at apply time. */
const ALLOWED_PATHS = [
  /^targets\.(role_terms|title_keywords|exclude_titles|preferred_levels)$/,
  /^targets\.title_keywords\.[a-z0-9_]+$/,
  /^location\.allow$/,
  /^filters\.(block_companies|block_content|exclude_seniority|deprioritize)$/,
  /^notes$/,
];

function pathAllowed(path) {
  return ALLOWED_PATHS.some((re) => re.test(path));
}

export function validateProposal(proposal) {
  const problems = [];
  if (!proposal?.id) problems.push('proposal has no id');
  if (!Array.isArray(proposal?.changes) || proposal.changes.length === 0) problems.push('proposal has no changes');

  for (const [i, change] of (proposal?.changes ?? []).entries()) {
    if (!OPS.has(change.op)) { problems.push(`change ${i}: unknown op "${change.op}"`); continue; }
    const path = change.op === 'add_note' ? 'notes' : change.path;
    if (!path) { problems.push(`change ${i}: no path`); continue; }
    if (!pathAllowed(path)) problems.push(`change ${i}: "${path}" is outside what the weekly loop may change`);
    if (change.value === undefined || change.value === null || change.value === '') {
      problems.push(`change ${i}: no value`);
    }
  }
  return problems;
}

/**
 * Apply a validated proposal to config/preferences.yml.
 * Throws rather than partially applying.
 */
export function applyProposal(proposal) {
  const problems = validateProposal(proposal);
  if (problems.length) throw new Error(`proposal is not applicable:\n  ${problems.join('\n  ')}`);
  if (!existsSync(PATHS.preferences)) throw new Error('config/preferences.yml does not exist');

  const original = readFileSync(PATHS.preferences, 'utf8');

  // Backup first. Every apply is one `cp` from being undone.
  const backup = join(PATHS.proposals, `preferences.before-${proposal.id}.yml`);
  copyFileSync(PATHS.preferences, backup);

  let text = original;
  for (const change of proposal.changes) {
    text = applyChange(text, change);
  }

  // Refuse to write a file that no longer parses. A broken preferences.yml
  // would fail every subsequent run, which is a much worse outcome than a
  // change that did not land.
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    throw new Error(`applying this proposal would produce invalid YAML (${err.message}) — nothing was written; backup at ${backup}`);
  }
  // Parsing is not enough: a file can parse and still fail the checks every run
  // starts with, which would stop every run until someone edited it by hand.
  const invalid = [...validateTargets(parsed?.targets ?? {}), ...validateLocation(parsed?.location ?? {})];
  if (invalid.length) {
    throw new Error(`applying this proposal would leave preferences.yml invalid — nothing was written:\n  ${invalid.join('\n  ')}`);
  }

  writeFileSync(PATHS.preferences, text);
  log.debug(`preferences.yml updated; backup at ${backup}`);
  return { backup, changes: proposal.changes.length };
}

// ── Text-level YAML editing ─────────────────────────────────────────
// Comment-preserving by construction: every edit is an insert or a delete of a
// single line, located by walking the file's own indentation.

function findBlock(lines, dottedPath) {
  const segments = dottedPath.split('.');
  let start = 0, end = lines.length, depth = 0;

  for (const segment of segments) {
    const indent = depth * 2;
    const keyRe = new RegExp(`^ {${indent}}${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
    let found = -1;

    for (let i = start; i < end; i++) {
      if (keyRe.test(lines[i])) { found = i; break; }
    }
    if (found === -1) return null;

    // The block runs to the next line at this indent or shallower that is not
    // blank and not a comment.
    let blockEnd = end;
    for (let i = found + 1; i < end; i++) {
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) { blockEnd = i; break; }
    }
    start = found + 1;
    end = blockEnd;
    depth++;
  }
  return { start, end, indent: depth * 2 };
}

function applyChange(text, change) {
  const lines = text.split('\n');
  const path = change.op === 'add_note' ? 'notes' : change.path;
  const op = change.op === 'add_note' ? 'add_list_item' : change.op;
  const value = change.value;

  const block = findBlock(lines, path);
  if (!block) throw new Error(`could not locate "${path}" in preferences.yml`);

  if (op === 'set_scalar') {
    // A scalar's key line is the line the walk ended just after.
    const keyLine = block.start - 1;
    lines[keyLine] = lines[keyLine].replace(/:.*$/, `: ${yamlScalar(value)}`);
    return lines.join('\n');
  }

  const itemIndent = ' '.repeat(block.indent);

  // A list written inline (`exclude_titles: ["intern", "sales"]`, or `notes: []`)
  // has no item lines to edit. Rewrite it as a block list first — items, then
  // any trailing comment kept on the key line — and apply the change to that.
  const keyLine = block.start - 1;
  const inline = lines[keyLine].match(/^(\s*[^\s#][^:#]*:)\s*(\[.*\])\s*(#.*)?$/);
  if (inline) {
    const items = yaml.load(inline[2]) ?? [];
    lines.splice(keyLine, 1, `${inline[1]}${inline[3] ? ` ${inline[3]}` : ''}`, ...items.map((v) => `${itemIndent}- ${yamlScalar(v)}`));
    return applyChange(lines.join('\n'), change);
  }

  if (op === 'remove_list_item') {
    for (let i = block.start; i < block.end; i++) {
      if (parseListItem(lines[i]) === String(value)) {
        lines.splice(i, 1);
        // Removing the last item must leave an empty list, not a bare key: YAML
        // reads `ml:` with nothing under it as null, which is not a list.
        let remaining = false;
        for (let j = block.start; j < block.end - 1; j++) if (/^\s*- /.test(lines[j])) { remaining = true; break; }
        if (!remaining) lines[keyLine] = lines[keyLine].replace(/:(\s*)(#.*)?$/, (_, sp, comment) => `: []${comment ? ` ${comment}` : ''}`);
        return lines.join('\n');
      }
    }
    throw new Error(`"${value}" is not in ${path} — it may already have been removed`);
  }

  // add_list_item — idempotent, so a proposal approved twice does nothing twice.
  for (let i = block.start; i < block.end; i++) {
    if (parseListItem(lines[i]) === String(value)) return text;
  }

  // Insert after the block's last real item, so the addition lands with the
  // list rather than after whatever trailing comment follows it.
  let insertAt = block.start;
  for (let i = block.start; i < block.end; i++) {
    if (/^\s*- /.test(lines[i])) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `${itemIndent}- ${yamlScalar(value)}`);
  return lines.join('\n');
}

function parseListItem(line) {
  const m = line.match(/^\s*- (.*)$/);
  if (!m) return null;
  return m[1].trim().replace(/^["'](.*)["']$/, '$1');
}

/** Quote anything YAML would otherwise misread. */
function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  return /^[\w][\w .\-/+&]*$/.test(s) && !/^(yes|no|on|off|true|false|null|~)$/i.test(s)
    ? s
    : JSON.stringify(s);
}

export { findBlock, applyChange, yamlScalar };
