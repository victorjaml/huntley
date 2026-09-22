import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

import { watchlistEntries, portfolioBoardEntries } from '../src/sources/watchlist.mjs';

// Shipped until 2026-09-18: entries were rebuilt from name/careers_url/
// provider/api only. Every Consider board failed every run with "needs a
// 'consider_board' id" while watchlist.yml had one, and Getro boards paged
// back 90 days instead of the configured 7 until the collection deadline cut
// them off. The error only ever reached the coverage report, not the log.
test('provider options on a watchlist entry reach the provider', () => {
  const doc = {
    portfolio_boards: [
      { name: 'Sequoia Capital (portfolio)', careers_url: 'https://jobs.sequoiacap.com/jobs',
        provider: 'consider', consider_board: 'sequoia-capital', consider_size: 250, enabled: true },
      { name: 'Accel (portfolio)', careers_url: 'https://jobs.accel.com/jobs',
        provider: 'getro', getro_max_age_days: 7, getro_collection: 4283, enabled: true },
      { name: 'Off (portfolio)', careers_url: 'https://jobs.off.test/jobs', provider: 'getro', enabled: false },
    ],
    tracked_companies: [
      { company: 'GE Grid', careers_url: 'https://ge.wd5.myworkdayjobs.com/x', provider: 'workday', max_pages: 150 },
    ],
  };

  const [sequoia, accel, ...rest] = portfolioBoardEntries(doc);
  assert.equal(rest.length, 0, 'a disabled entry is still left out');
  assert.equal(sequoia.consider_board, 'sequoia-capital');
  assert.equal(sequoia.consider_size, 250);
  assert.equal(accel.getro_max_age_days, 7);
  assert.equal(accel.getro_collection, 4283);
  assert.equal('enabled' in sequoia, false, 'bookkeeping keys are not passed to providers');

  const [ge] = watchlistEntries(doc);
  assert.equal(ge.name, 'GE Grid', '`company` still stands in for a missing name');
  assert.equal(ge.max_pages, 150, 'the "raise max_pages on this entry" advice can now be followed');
  assert.equal('company' in ge, false);
});

test('every option set in the real watchlist.yml survives loading', () => {
  const doc = yaml.load(readFileSync(new URL('../config/watchlist.yml', import.meta.url), 'utf8'));
  const loaded = [...watchlistEntries(doc), ...portfolioBoardEntries(doc)];
  const source = [...(doc.tracked_companies ?? []), ...(doc.portfolio_boards ?? [])]
    .filter((c) => c && c.enabled !== false);
  for (const raw of source) {
    const entry = loaded.find((e) => e.careers_url === raw.careers_url);
    assert.ok(entry, `${raw.name} loaded`);
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'enabled' || key === 'company') continue;
      assert.deepEqual(entry[key], value, `${raw.name}: ${key}`);
    }
  }
});
