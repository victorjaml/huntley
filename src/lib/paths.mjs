// Path resolution for huntley. Every runtime artifact lands under data/, which
// is gitignored in full — a fresh clone carries no trace of whose search it ran.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Where runtime state lives. Overridable, and that is not a convenience — it is
// a safety property. Without it every consumer of PATHS writes to the one real
// data directory, so a test that wants a scratch scan-history has no way to ask
// for one and silently overwrites yours instead. (It did. That is why this
// exists.) It also allows a second search lane with its own history.
const DATA_DIR = process.env.HUNTLEY_DATA_DIR?.trim()
  ? resolve(ROOT, process.env.HUNTLEY_DATA_DIR.trim())
  : join(ROOT, 'data');

const CONFIG_DIR = process.env.HUNTLEY_CONFIG_DIR?.trim()
  ? resolve(ROOT, process.env.HUNTLEY_CONFIG_DIR.trim())
  : join(ROOT, 'config');

export const PATHS = {
  root: ROOT,

  // Config lives beside the code by default. HUNTLEY_CONFIG_DIR redirects it
  // for the same reason HUNTLEY_DATA_DIR redirects state: a test that writes a
  // fixture watchlist.yml must not be able to overwrite a real watchlist.
  config: CONFIG_DIR,
  huntleyConfig: join(CONFIG_DIR, 'huntley.yml'),
  preferences: join(CONFIG_DIR, 'preferences.yml'),
  // What to scan: companies, VC portfolio boards and fund portfolios.
  watchlist: join(CONFIG_DIR, 'watchlist.yml'),

  data: DATA_DIR,
  // Huntley-owned board collection observations / sweep checkpoints.
  collection: join(DATA_DIR, 'collection'),
  // Fund portfolio company lists and resolved boards — see src/sources/funds/.
  funds: join(DATA_DIR, 'funds'),
  // Boards that have produced a role passing your filters — see active-boards.mjs.
  activeBoards: join(DATA_DIR, 'active-boards.json'),
  boardNames: join(DATA_DIR, 'cache', 'board-names.json'),

  digests: join(DATA_DIR, 'digests'),
  shortlist: join(DATA_DIR, 'shortlist.jsonl'),
  seen: join(DATA_DIR, 'seen.tsv'),
  runs: join(DATA_DIR, 'runs'),
  progress: join(DATA_DIR, 'progress.json'),
  roles: join(DATA_DIR, 'roles.json'),
  lock: join(DATA_DIR, '.huntley.lock'),
  proposals: join(DATA_DIR, 'proposals'),
  cache: join(DATA_DIR, 'cache'),
};

/** Create every directory huntley writes into. Idempotent; safe on every run. */
export function ensureDirs() {
  for (const dir of [
    PATHS.data,
    PATHS.collection,
    join(PATHS.collection, 'observations'),
    join(PATHS.collection, 'sweeps'),
    join(PATHS.collection, 'cache'),
    PATHS.digests,
    PATHS.runs,
    PATHS.proposals,
    PATHS.cache,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
