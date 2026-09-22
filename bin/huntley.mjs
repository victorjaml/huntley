#!/usr/bin/env node
// huntley — a personal job-search pipeline.
//
//   huntley run        scan, catch up since last success, write a local report
//   huntley daily      alias for run
//   huntley weekly     review the tracker and propose preference updates
//   huntley sync       pull Add/APPROVE clicks back from the tracker sheet
//   huntley doctor     check the install, config, and every credential
//   huntley setup      create config files from the examples
//
// Nothing here ever submits an application.

import { log } from '../src/lib/log.mjs';
import { ConfigError } from '../src/config.mjs';

const USAGE = `
huntley — discovery you can trust, run locally whenever you want.

USAGE
  huntley <command> [options]

COMMANDS
  run              Scan → catch up → rank → write a complete local report
                   (and email a shorter summary if configured)
  daily            Alias for run
  weekly           Review outcomes and EMAIL a proposed preference diff
  sync             Read Add / APPROVE clicks back from the tracker sheet
  doctor           Verify config, credentials, and board providers
  setup            Create config/*.yml and .env from the shipped examples
                   setup --cv <path>  summarise a resume into preferences.yml
  discover-board   Resolve a company name to a scannable ATS board (preview;
                   pass --write to append to config/watchlist.yml)

OPTIONS
  --cv <path>      (setup) Read a .tex/.md/.txt resume (or a folder) once and
                   write preferences.background.summary
  --dry-run        Preview using existing progress; write preview artifacts only
  --no-scan        Reuse a stored snapshot; re-rank and republish locally
  --run-id <id>    (with --no-scan) replay this snapshot instead of the latest
  --since <when>   Widen the catch-up lower bound (ISO date or timestamp)
  --fresh          Deprecated: normal runs already fetch; never clears history
  --force          (weekly) Propose even when the evidence is thin
  --apply <id>     (weekly) Apply a stored proposal by hand, without a click
  --write          (discover-board) Append resolved boards to watchlist.yml
  --summary        (discover-board) Human-readable table (default)
  --verbose        Debug logging
  --trace          Very verbose
  --quiet          Warnings and errors only
  --help           This text

EXAMPLES
  huntley setup --cv ~/resume.tex
  npm run huntley -- run --dry-run
  huntley run
  huntley daily                    # same engine as run
  huntley weekly --dry-run

Add means "I want to apply", not "I applied". You apply yourself; huntley never submits anything.
`;

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cv' || a === '--apply' || a === '--since' || a === '--run-id') {
      const key = a.slice(2);
      const val = argv[i + 1];
      flags.add(a);
      if (val && !val.startsWith('-')) {
        values[key] = val;
        i++;
      }
    } else if (a.startsWith('--cv=')) {
      flags.add('--cv');
      values.cv = a.slice(5);
    } else if (a.startsWith('--apply=')) {
      flags.add('--apply');
      values.apply = a.slice(8);
    } else if (a.startsWith('--since=')) {
      flags.add('--since');
      values.since = a.slice(8);
    } else if (a.startsWith('--run-id=')) {
      flags.add('--run-id');
      values['run-id'] = a.slice(9);
    } else if (a.startsWith('-')) {
      flags.add(a);
    } else {
      rest.push(a);
    }
  }
  const [command, ...positional] = rest;
  return { command, flags, values, positional };
}

async function main() {
  const { command, flags, values, positional } = parseArgs(process.argv.slice(2));

  if (flags.has('--trace')) log.setLevel('trace');
  else if (flags.has('--verbose')) log.setLevel('debug');
  else if (flags.has('--quiet')) log.setLevel('warn');

  if (!command || flags.has('--help') || flags.has('-h') || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const opts = {
    dryRun: flags.has('--dry-run'),
    noScan: flags.has('--no-scan'),
    fresh: flags.has('--fresh'),
    apply: flags.has('--apply'),
    force: flags.has('--force'),
    cv: values.cv ?? null,
    since: values.since ?? null,
    runId: values['run-id'] ?? null,
    positional: values.apply ? [values.apply, ...positional] : positional,
  };

  switch (command) {
    case 'setup': {
      const { runSetup } = await import('../src/setup.mjs');
      return runSetup(opts);
    }
    case 'doctor': {
      const { runDoctor } = await import('../src/doctor.mjs');
      return runDoctor(opts);
    }
    case 'run':
    case 'daily': {
      const { loadConfig } = await import('../src/config.mjs');
      const { runHuntley } = await import('../src/run.mjs');
      const result = await runHuntley(loadConfig(), opts);
      return result.exitCode ?? 0;
    }
    case 'weekly': {
      const { loadConfig } = await import('../src/config.mjs');
      const { runWeekly } = await import('../src/weekly.mjs');
      return (await runWeekly(loadConfig(), opts)) ?? 0;
    }
    case 'sync': {
      const { loadConfig } = await import('../src/config.mjs');
      const { runSync } = await import('../src/sheet/sync.mjs');
      return runSync(loadConfig(), opts);
    }
    case 'discover-board': {
      const { runDiscoverBoardCli } = await import('../src/sources/boards/discover.mjs');
      await runDiscoverBoardCli([...opts.positional, ...[...flags]]);
      return process.exitCode ?? 0;
    }
    default:
      log.error(`Unknown command "${command}"`);
      process.stdout.write(USAGE);
      return 2;
  }
}

try {
  process.exitCode = (await main()) ?? 0;
} catch (err) {
  if (err instanceof ConfigError) {
    log.error(err.message);
    log.info('Run `huntley setup` to create the config files, then edit them.');
  } else {
    log.error(err.stack ?? err.message);
  }
  process.exitCode = 1;
}
