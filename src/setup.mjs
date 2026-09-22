// `huntley setup` — turn a fresh clone into a runnable install.
//
// Copies each shipped example into its real, gitignored counterpart and
// generates a link-signing secret. It never overwrites a file you already have.
//
// Optional: `huntley setup --cv /path/to/resume.tex` reads the resume once,
// summarises it into preferences.background.summary, and stops. Ranking never
// opens the resume again.

import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PATHS, ensureDirs } from './lib/paths.mjs';
import { log } from './lib/log.mjs';

const FILES = [
  { example: join(PATHS.config, 'huntley.example.yml'),     target: PATHS.huntleyConfig, label: 'plumbing' },
  { example: join(PATHS.config, 'preferences.example.yml'), target: PATHS.preferences,   label: 'preference memory' },
  { example: join(PATHS.config, 'watchlist.example.yml'),   target: PATHS.watchlist,     label: 'company watchlist' },
  { example: join(PATHS.root, '.env.example'),              target: join(PATHS.root, '.env'), label: 'secrets' },
];

export async function runSetup(opts = {}) {
  ensureDirs();

  let created = 0;
  for (const { example, target, label } of FILES) {
    if (existsSync(target)) { log.info(`kept existing ${label}: ${rel(target)}`); continue; }
    if (!existsSync(example)) { log.warn(`missing example: ${rel(example)}`); continue; }
    copyFileSync(example, target);
    log.ok(`created ${label}: ${rel(target)}`);
    created++;
  }

  // A signing secret, generated once. Without it Add links cannot exist.
  const envPath = join(PATHS.root, '.env');
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, 'utf8');
    if (/^HUNTLEY_LINK_SECRET=\s*$/m.test(env)) {
      const secret = randomBytes(32).toString('base64url');
      writeFileSync(envPath, env.replace(/^HUNTLEY_LINK_SECRET=\s*$/m, `HUNTLEY_LINK_SECRET=${secret}`));
      log.ok('generated HUNTLEY_LINK_SECRET in .env');
      log.info('  paste the same value into the Apps Script Script Properties (docs/google-sheets-setup.md)');
    }
  }

  if (opts.cv) {
    try {
      await importCv(opts.cv);
    } catch (err) {
      log.error(`resume import failed: ${err.message}`);
      return 1;
    }
  }

  log.info('');
  if (created === 0 && !opts.cv) {
    log.info('Nothing to create — this install is already set up. Run `huntley doctor`.');
    log.info('To refresh background.summary from a resume: huntley setup --cv /path/to/resume.tex');
  } else if (!opts.cv) {
    log.step('Next:');
    log.info('  1. huntley setup --cv ~/path/to/resume.tex   — fills preferences.background.summary');
    log.info('  2. Edit config/preferences.yml   — titles, location, strengths');
    log.info('  3. Edit config/watchlist.yml     — the companies and VC boards to scan');
    log.info('  4. Edit config/huntley.yml       — your email address');
    log.info('  5. huntley run --dry-run         — writes a local report, sends nothing');
  }
  return 0;
}

async function importCv(path) {
  const { readCvSource, summarizeResume, writeBackgroundSummary } = await import('./setup/cv.mjs');
  let rank = {};
  try {
    const { loadConfig } = await import('./config.mjs');
    rank = loadConfig({ requirePreferences: false }).rank ?? {};
  } catch { /* config may still be the example; CLI auto-detect is fine */ }

  const { path: resolved, text } = readCvSource(path);
  log.ok(`read resume ${rel(resolved)} (${text.length} chars of prose)`);
  const summary = await summarizeResume(text, { cli: rank.cli, model: rank.model, timeoutMs: rank.timeout_ms });
  const { backup, chars } = writeBackgroundSummary(summary);
  log.ok(`wrote preferences.background.summary (${chars} chars)`);
  log.info(`  previous file backed up at ${rel(backup)}`);
}

function rel(p) { return p.replace(PATHS.root + '/', ''); }
