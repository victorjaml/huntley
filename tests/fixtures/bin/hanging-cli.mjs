#!/usr/bin/env node
// Fixture CLI used to verify askCli kill + process-group cleanup.
//
// Spawns a descendant that inherits stdout and then sleeps. Killing only this
// process leaves the descendant holding the pipe open — without process-group
// kill + bounded cleanup, the parent ranker would wait indefinitely for
// ChildProcess 'close'.

import { spawn } from 'node:child_process';

const holdMs = Number(process.env.HUNTLEY_STUB_HOLD_MS ?? 30_000);
// Inherit stdout/stderr so the descendant keeps the parent's pipes open after
// this process is killed.
spawn(process.execPath, ['-e', `setInterval(() => {}, ${Math.max(holdMs, 1000)})`], {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: false,
});

process.stdout.write('stub-cli: holding pipes via descendant\n');
// Stay alive until killed; never exit cleanly on our own.
setInterval(() => {}, 1000);
