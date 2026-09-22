import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planUnitWindow, parseSinceInput, freezeClock, sourceHorizonMs, planRunWindows, clampRelevanceWindow, ageDaysCeil, DAY_MS, HOUR_MS } from '../src/state/window.mjs';
import { acquireLock, isProcessAlive } from '../src/state/lock.mjs';
import { coverageUnit, canAdvanceCheckpoint, summarizeCoverage, completeUnitIdentities, unitKey, formatCoverageSummary, unitsFailedAcrossRuns, collectionUnitLists } from '../src/state/coverage.mjs';
import { linkedinUnitKey } from '../src/sources/linkedin.mjs';
import { wellfoundUnitKey } from '../src/sources/wellfound.mjs';
import { freehireUnitKey } from '../src/sources/freehire.mjs';
import { planFreehireFeedWindows } from '../src/sources/ats-lanes.mjs';
import { enqueuePendingEmail, dequeuePendingEmail, pendingEmailQueue, applyCheckpoints, laterTimestamp } from '../src/state/catchup.mjs';

test('relevance-ranked searches fetch the configured horizon and leave the catch-up tail as a gap', () => {
  const until = Date.parse('2026-10-20T12:00:00Z');
  const bootstrap = planUnitWindow({
    coveredThrough: null,
    runStartedAt: until,
    initialLookbackDays: 30,
    overlapHours: 48,
    sourceHorizonMs: sourceHorizonMs(2, until),
  });
  assert.equal(ageDaysCeil(bootstrap.since, until), 32);

  const freehire = clampRelevanceWindow(bootstrap, { configuredDays: 2, untilMs: until });
  assert.equal(freehire.fetchDays, 2);
  assert.equal(freehire.fetchSince, until - 2 * DAY_MS);
  assert.equal(freehire.gap.uncoveredSince, bootstrap.since);
  assert.equal(freehire.gap.uncoveredUntil, freehire.fetchSince);

  const wellfound = clampRelevanceWindow(bootstrap, { configuredDays: 14, untilMs: until });
  assert.equal(wellfound.fetchDays, 14);
  assert.ok(wellfound.gap);

  const recent = clampRelevanceWindow(
    { since: until - DAY_MS, until },
    { configuredDays: 2, untilMs: until },
  );
  assert.equal(recent.gap, null);
  assert.equal(recent.fetchDays, 1);
});

test('a two-week gap uses the last success plus overlap, not a 1–3 day cap', () => {
  const runStartedAt = Date.parse('2026-09-15T12:00:00Z');
  const win = planUnitWindow({
    coveredThrough: '2026-09-01T12:00:00.000Z',
    runStartedAt,
    initialLookbackDays: 30,
    overlapHours: 48,
    sourceHorizonMs: sourceHorizonMs(3, runStartedAt),
    mode: 'since_last_success',
  });
  assert.equal(win.since, Date.parse('2026-09-01T12:00:00.000Z') - 48 * HOUR_MS);
  assert.ok(win.since < runStartedAt - 3 * DAY_MS, 'wider than the old 3-day dataset window');
  const dates = ['2026-09-02', '2026-09-08', '2026-09-14'].map((d) => Date.parse(`${d}T12:00:00Z`));
  for (const ms of dates) assert.ok(ms >= win.since && ms <= win.until);
});

test('--since date-only is UTC midnight and cannot skip outstanding coverage', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.equal(parseSinceInput('2026-09-01', { now }).ms, Date.parse('2026-09-01T00:00:00Z'));
  assert.equal(parseSinceInput('2099-01-01', { now }).ok, false);
  const lower = Date.parse('2026-09-01T12:00:00.000Z') - 48 * HOUR_MS;
  assert.throws(() => planUnitWindow({
    coveredThrough: '2026-09-01T12:00:00.000Z',
    runStartedAt: now,
    initialLookbackDays: 30,
    overlapHours: 48,
    explicitSinceMs: Date.parse('2026-09-10T00:00:00Z'),
  }), /skip outstanding coverage/);
  const widened = planUnitWindow({
    coveredThrough: '2026-09-01T12:00:00.000Z',
    runStartedAt: now,
    initialLookbackDays: 30,
    overlapHours: 48,
    explicitSinceMs: Date.parse('2026-08-01T00:00:00Z'),
  });
  assert.equal(widened.since, Date.parse('2026-08-01T00:00:00Z'));
  assert.ok(lower > widened.since);
});

test('--since is validated against stored checkpoints, not a phantom bootstrap window', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const collection = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const progress = {
    units: {
      'watchlist:https://jobs.ashbyhq.com/acme': { coveredThrough: '2026-09-14T12:00:00.000Z' },
    },
  };
  const planned = [{ key: 'watchlist:https://jobs.ashbyhq.com/acme' }];
  const { summary } = planRunWindows(planned, {
    progress, runStartedAt: now, collection, explicitSinceMs: Date.parse('2026-09-01T00:00:00Z'),
  });
  assert.equal(summary.since, Date.parse('2026-09-01T00:00:00Z'));
  assert.throws(() => planUnitWindow({
    coveredThrough: null,
    runStartedAt: now,
    initialLookbackDays: 30,
    overlapHours: 48,
    explicitSinceMs: Date.parse('2026-09-01T00:00:00Z'),
  }), /skip outstanding coverage/, 'the old global bootstrap is what incorrectly rejected this --since');
});

test('--since ignores checkpoints for units that are not participating', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const collection = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const { summary } = planRunWindows(
    [{ key: 'watchlist:https://jobs.ashbyhq.com/acme' }],
    {
      progress: {
        units: {
          'watchlist:https://jobs.ashbyhq.com/acme': { coveredThrough: '2026-09-14T12:00:00.000Z' },
          'linkedin:engineer|san francisco|': { coveredThrough: '2026-07-01T12:00:00.000Z' },
        },
      },
      runStartedAt: now,
      collection,
      explicitSinceMs: Date.parse('2026-09-01T00:00:00Z'),
    },
  );
  assert.equal(summary.since, Date.parse('2026-09-01T00:00:00Z'));
});

test('completeUnitIdentities keeps only units that actually finished', () => {
  const urls = completeUnitIdentities([
    coverageUnit({ key: 'active_boards:https://jobs.lever.co/ok', status: 'complete', requestedUntil: '2026-09-15T12:00:00.000Z' }),
    coverageUnit({ key: 'active_boards:https://jobs.lever.co/fail', status: 'failed', requestedUntil: '2026-09-15T12:00:00.000Z' }),
    coverageUnit({ key: 'watchlist:https://jobs.lever.co/other', status: 'complete', requestedUntil: '2026-09-15T12:00:00.000Z' }),
  ], 'active_boards');
  assert.deepEqual(urls, ['https://jobs.lever.co/ok']);
});

test('search windows follow query identities, not a shared :lane key', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const collection = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const linkedin = linkedinUnitKey('engineer', 'San Francisco', '');
  const wellfound = wellfoundUnitKey('software-engineer', 'san-francisco');
  const freehire = freehireUnitKey('engineer', ['us']);
  const { windows } = planRunWindows(
    [{ key: linkedin }, { key: wellfound }, { key: freehire }],
    {
      progress: {
        units: {
          'linkedin:lane': { coveredThrough: '2026-10-18T12:00:00.000Z' },
          'wellfound:lane': { coveredThrough: '2026-10-18T12:00:00.000Z' },
          'freehire:lane': { coveredThrough: '2026-10-18T12:00:00.000Z' },
          [linkedin]: { coveredThrough: '2026-09-14T12:00:00.000Z' },
          [wellfound]: { coveredThrough: '2026-09-14T12:00:00.000Z' },
          [freehire]: { coveredThrough: '2026-09-14T12:00:00.000Z' },
        },
      },
      runStartedAt: now,
      collection,
    },
  );
  for (const key of [linkedin, wellfound, freehire]) {
    const win = windows.find((w) => w.key === key);
    assert.ok(win, key);
    assert.ok(win.since < Date.parse('2026-09-16T00:00:00Z'), `${key} must reuse the September checkpoint`);
  }
});

test('a new pending email is appended instead of replacing the previous one', () => {
  const progress = { pendingEmails: [{ runId: 'old-mail', subject: 'huntley · old' }] };
  enqueuePendingEmail(progress, { runId: 'new-mail', subject: 'huntley · new' });
  assert.deepEqual(pendingEmailQueue(progress).map((e) => e.runId), ['old-mail', 'new-mail']);
  dequeuePendingEmail(progress, 'new-mail');
  assert.deepEqual(pendingEmailQueue(progress).map((e) => e.runId), ['old-mail']);
});

test('clearing the last pendingEmails entry is not undone by pendingEmail', () => {
  const progress = {
    pendingEmails: [{ runId: 'last-mail', subject: 'huntley · last' }],
    pendingEmail: { runId: 'last-mail', subject: 'huntley · last' },
  };
  dequeuePendingEmail(progress, 'last-mail');
  assert.deepEqual(progress.pendingEmails, []);
  assert.equal(progress.pendingEmail, null);
  assert.deepEqual(pendingEmailQueue({
    pendingEmails: [],
    pendingEmail: { runId: 'last-mail', subject: 'huntley · last' },
  }), [], 'an explicit empty array is authoritative; the singular field is legacy-only');
  assert.deepEqual(
    pendingEmailQueue({ pendingEmail: { runId: 'last-mail', subject: 'huntley · last' } }).map((e) => e.runId),
    ['last-mail'],
  );
});

test('freehire feed countries plan independently and fetch from the earliest window', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const collection = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const us = unitKey('freehire_feed', 'us');
  const ca = unitKey('freehire_feed', 'ca');
  const progress = { units: { [us]: { coveredThrough: '2026-10-18T12:00:00.000Z' } } };
  const canadaOnly = planFreehireFeedWindows({ countries: ['ca'], open_within_days: 2 }, {
    now, progress, collection,
  });
  assert.equal(canadaOnly.windows.length, 1);
  assert.equal(canadaOnly.windows[0].key, ca);
  assert.ok(canadaOnly.fetchSince < Date.parse('2026-09-22T00:00:00Z'), 'Canada must bootstrap instead of inheriting the US cutoff');
  const both = planFreehireFeedWindows({ countries: ['us', 'ca'], open_within_days: 2 }, {
    now, progress, collection,
  });
  const usWin = both.windows.find((w) => w.key === us);
  const caWin = both.windows.find((w) => w.key === ca);
  assert.ok(usWin.since > Date.parse('2026-10-15T00:00:00Z'), 'US keeps its recent checkpoint');
  assert.ok(caWin.since < Date.parse('2026-09-22T00:00:00Z'));
  assert.equal(both.fetchSince, caWin.since);
});

test('freehire feed uses its own overlap_hours when set', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const collection = { mode: 'since_last_success', initialLookbackDays: 30, overlapHours: 48 };
  const us = unitKey('freehire_feed', 'us');
  const progress = { units: { [us]: { coveredThrough: '2026-10-18T12:00:00.000Z' } } };
  const global = planFreehireFeedWindows({ countries: ['us'], open_within_days: 2 }, {
    now, progress, collection,
  });
  const own = planFreehireFeedWindows({ countries: ['us'], open_within_days: 2, overlap_hours: 6 }, {
    now, progress, collection,
  });
  assert.equal(global.windows[0].since, Date.parse('2026-10-16T12:00:00.000Z'));
  assert.equal(own.windows[0].since, Date.parse('2026-10-18T06:00:00.000Z'));
});

test('coverage summary lists failing units; doctor helper needs three consecutive failures', () => {
  const failed = coverageUnit({
    key: 'portfolio:https://jobs.sequoiacap.com',
    status: 'failed',
    errors: ["consider: Sequoia needs a 'consider_board' id"],
  });
  const ok = coverageUnit({ key: 'watchlist:https://jobs.ashbyhq.com/acme', status: 'complete', requestedUntil: '2026-09-18T00:00:00.000Z' });
  const { lines, failing } = formatCoverageSummary([ok, failed]);
  assert.equal(failing.length, 1);
  assert.match(lines[0].message, /1 complete · 0 partial · 1 failed/);
  assert.equal(lines[1].level, 'error');
  assert.match(lines[1].message, /portfolio:https:\/\/jobs\.sequoiacap\.com — consider:/);

  assert.deepEqual(unitsFailedAcrossRuns([[failed], [failed]], { consecutive: 3 }), []);
  assert.deepEqual(
    unitsFailedAcrossRuns([[failed, ok], [failed], [failed]], { consecutive: 3 }),
    [failed.key],
  );
  assert.deepEqual(
    unitsFailedAcrossRuns([[failed], [ok], [failed]], { consecutive: 3 }),
    [],
  );
});

test('doctor ignores replay manifests and empty unit lists', () => {
  const failed = coverageUnit({
    key: 'portfolio:https://jobs.sequoiacap.com',
    status: 'failed',
    errors: ["consider: Sequoia needs a 'consider_board' id"],
  });
  const run = (units, extra = {}) => ({ coverage: { units }, ...extra });
  const lists = collectionUnitLists([
    run([failed]),
    { replay: { id: 'old' }, coverage: { units: [] } },
    run([]),
    run([failed]),
    run([failed]),
  ], { consecutive: 3 });
  assert.equal(lists.length, 3);
  assert.deepEqual(unitsFailedAcrossRuns(lists, { consecutive: 3 }), [failed.key]);
});

test('a frozen clock is reused rather than calling Date.now per cutoff', () => {
  const clock = freezeClock(Date.parse('2026-09-15T18:00:00Z'));
  assert.equal(clock.iso, '2026-09-15T18:00:00.000Z');
  assert.equal(clock.utcDate, '2026-09-15');
});

test('only complete units, or date-sorted partials with a coveredThrough, may advance a checkpoint', () => {
  const complete = coverageUnit({ key: 'watchlist:https://x.test', status: 'complete', requestedUntil: '2026-09-15T12:00:00.000Z', recordsFetched: 0 });
  const failed = coverageUnit({ key: 'watchlist:https://y.test', status: 'failed', requestedUntil: '2026-09-15T12:00:00.000Z' });
  const datedPartial = coverageUnit({
    key: 'linkedin:engineer|sf|',
    status: 'partial',
    requestedUntil: '2026-09-15T12:00:00.000Z',
    coveredThrough: '2026-09-14T00:00:00.000Z',
  });
  const cappedPartial = coverageUnit({
    key: 'linkedin:other|sf|',
    status: 'partial',
    requestedUntil: '2026-09-15T12:00:00.000Z',
  });
  assert.equal(canAdvanceCheckpoint(complete), true);
  assert.equal(complete.coveredThrough, '2026-09-15T12:00:00.000Z');
  assert.equal(canAdvanceCheckpoint(failed), false);
  assert.equal(failed.coveredThrough, null);
  assert.equal(canAdvanceCheckpoint(datedPartial), true);
  assert.equal(canAdvanceCheckpoint(cappedPartial), false);
  const summary = summarizeCoverage([complete, failed]);
  assert.equal(summary.retrievalComplete, false);
  assert.equal(summary.failed, 1);
});

test('applyCheckpoints never moves coveredThrough backwards', () => {
  assert.equal(laterTimestamp('2026-09-14T12:00:00.000Z', '2026-09-10T00:00:00.000Z'), '2026-09-14T12:00:00.000Z');
  const progress = {
    units: {
      'linkedin:engineer|sf|': { coveredThrough: '2026-09-14T12:00:00.000Z', status: 'partial' },
    },
  };
  const older = coverageUnit({
    key: 'linkedin:engineer|sf|',
    status: 'partial',
    requestedUntil: '2026-09-20T12:00:00.000Z',
    coveredThrough: '2026-09-10T00:00:00.000Z',
  });
  applyCheckpoints(progress, [older], 'run-2');
  assert.equal(progress.units['linkedin:engineer|sf|'].coveredThrough, '2026-09-14T12:00:00.000Z');

  const freehireKey = 'freehire:research engineer|us';
  const poisoned = {
    units: { [freehireKey]: { coveredThrough: '2026-08-19T00:00:00.000Z', status: 'partial' } },
  };
  applyCheckpoints(poisoned, [coverageUnit({
    key: freehireKey,
    status: 'partial',
    requestedUntil: '2026-09-20T12:00:00.000Z',
    limitations: ['top 50 of 13207 by relevance; freehire_feed covers the rest'],
  })], 'run-3');
  assert.equal(poisoned.units[freehireKey].coveredThrough, undefined);
});

test('a second writer is refused; a stale lock from a dead pid is recovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-lock-'));
  const first = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /Another huntley process/);
  first.release();
  const lockPath = join(dir, '.huntley.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
  assert.equal(isProcessAlive(999999999), false);
  const recovered = acquireLock(dir);
  recovered.release();
  writeFileSync(lockPath, 'not-json');
  assert.throws(() => acquireLock(dir), /corrupt/);
});

test('same-process leftover lock is recovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'huntley-lock2-'));
  const held = acquireLock(dir);
  held.release();
  writeFileSync(join(dir, '.huntley.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const again = acquireLock(dir);
  again.release();
});
