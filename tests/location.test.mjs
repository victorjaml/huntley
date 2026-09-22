import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocation, parseAllowEntry } from '../src/rank/places.mjs';
import { prefilter } from '../src/rank/prefilter.mjs';
import { validateLocation } from '../src/config.mjs';
import { toJob } from '../src/normalize.mjs';

// The operator's rule: an office anywhere in California, or in NYC, Austin,
// Seattle, Portland or Chicago. Remote is fine but ranks lower. Nothing else is
// listed — recognising every other place is huntley's job.
const loc = {
  allow: ['California', 'New York, NY', 'NYC', 'Brooklyn, NY', 'Austin, TX', 'Seattle, WA', 'Portland, OR', 'Chicago, IL'],
  remote: 'rank_lower',
};
const where = (l) => classifyLocation(l, loc);

const CASES = {
  office: [
    'San Francisco, CA', 'San Francisco', 'Cupertino', 'Los Angeles Metropolitan Area', 'Carlsbad, CA',
    'Los Angeles, California, United States', 'San Francisco Bay Area', 'New York, NY', 'New York',
    'New York City, New York, United States', 'Brooklyn, New York', 'Austin, TX', 'Seattle, WA',
    'Portland, OR', 'Portland', 'Chicago', 'London & San Francisco', 'San Francisco, CA · London · United Kingdom',
    'Boston (Onsite), New York',
  ],
  remote: [
    'Remote', 'Remote - US', 'US (Remote)', 'USA - Remote', 'United States', 'United States, Remote',
    'Pittsburgh, PA or Remote', 'United States · Canada',
  ],
  other: [
    'Rochester, New York, United States', 'West New York, NJ', 'Yonkers, NY', 'Portland, ME',
    'Boston, MA', 'Boston, Massachusetts, United States', 'Cambridge, MA', 'Vancouver, WA',
    'Toronto, ON, CA', 'Calgary, AB, CA', 'Vancouver, CA', 'London', 'London, UK', 'Paris, TX',
    'Bengaluru, India', 'New Mexico', 'Mexico City',
    'Remote, UK', 'United Kingdom · Europe · European Union · Remote', 'Remote (EMEA)', 'Remote - Canada',
  ],
  unknown: ['', 'N/A', 'TBD', '-'],
};

for (const [want, locations] of Object.entries(CASES)) {
  test(`${want}: ${locations.length} real location strings`, () => {
    for (const l of locations) assert.equal(where(l), want, JSON.stringify(l));
  });
}

test('the traps, named', () => {
  assert.equal(where('Portland, ME'), 'other', 'Portland, Maine is not the Portland you listed');
  assert.equal(where('Rochester, New York, United States'), 'other', 'a New York State city is not New York City');
  assert.equal(where('Calgary, AB, CA'), 'other', '"CA" after a Canadian province is Canada, not California');
  assert.equal(where('Cupertino'), 'office', 'a bare California city is in California');
  assert.equal(where('Boston, Massachusetts, United States'), 'other', 'a city followed by a country is not remote');
  assert.equal(where('United Kingdom · Europe · European Union · Remote'), 'other', 'a bare "Remote" in a European posting is European');
});

test('allow entries: a state, a city in a state, or a city', () => {
  assert.deepEqual(parseAllowEntry('California'), { state: 'ca' });
  assert.deepEqual(parseAllowEntry('CA'), { state: 'ca' });
  assert.deepEqual(parseAllowEntry('Seattle, WA'), { city: 'seattle', state: 'wa' });
  assert.deepEqual(parseAllowEntry('NYC'), { city: 'nyc', state: 'ny' });
});

test('with no allow-list, anywhere in the US is an office and abroad is not', () => {
  const any = { allow: [] };
  assert.equal(classifyLocation('Ann Arbor, MI', any), 'office');
  assert.equal(classifyLocation('Toronto, Canada', any), 'other');
  assert.equal(classifyLocation('Remote', any), 'remote');
});

// ── Remote policy, end to end through the prefilter ─────────────────

const prefs = (remote) => ({ targets: { role_terms: ['engineer*'] }, location: { ...loc, remote }, filters: {} });
const job = (company, location) => toJob({ url: `https://x.test/${company}`, title: 'Engineer', company, location });

test('rank_lower: remote is kept but presorts below the same role with an office', () => {
  const { kept } = prefilter([job('Remote Co', 'Remote - US'), job('Office Co', 'Seattle, WA')], prefs('rank_lower'));
  assert.deepEqual(kept.map((k) => k.company), ['Office Co', 'Remote Co']);
  assert.equal(kept[1].workplace, 'remote');
});

test('accept: remote is not penalised', () => {
  const { kept } = prefilter([job('Remote Co', 'Remote - US'), job('Office Co', 'Seattle, WA')], prefs('accept'));
  assert.equal(kept.find((k) => k.company === 'Remote Co').heuristic + 8, kept.find((k) => k.company === 'Office Co').heuristic);
});

test('exclude: remote-only roles are rejected, but "Seattle or Remote" is still an office role', () => {
  const { kept, rejected } = prefilter([job('Remote Co', 'Remote - US'), job('Either Co', 'Seattle, WA or Remote')], prefs('exclude'));
  assert.deepEqual(kept.map((k) => k.company), ['Either Co']);
  assert.match(rejected[0].reason, /remote roles are excluded/);
});

test('the keys this replaced are reported, not silently ignored', () => {
  const problems = validateLocation({ allow: ['California'], block: ['London'], always_allow: ['SF'] });
  assert.ok(problems.some((p) => /location.block is no longer used/.test(p)));
  assert.ok(problems.some((p) => /location.always_allow is no longer used/.test(p)));
  assert.ok(validateLocation({ remote: 'sometimes' }).some((p) => /rank_lower, accept, exclude/.test(p)));
});

test('comma-only lists of several places are read as several places', () => {
  assert.equal(where('San Francisco, CA, USA, New York, NY, USA, Boston, MA, USA'), 'office');
  assert.equal(where('Miami, FL, USA, New York, NY, USA'), 'office');
  assert.equal(where('Texas, USA, New York, USA, Remote, New York'), 'office');
  assert.equal(where('Dallas, TX, United States'), 'other');
});

test('addresses, office notes and state names inside phrases', () => {
  assert.equal(where('1-02 26TH AVENUE, ASTORIA, NY 11102'), 'office', 'a street address in Queens is New York City');
  assert.equal(where('Hybrid- Any Office (Fremont, CA, Salem, OR, or Pittsburgh, PA)'), 'office');
  assert.equal(where('Roving California - CA'), 'office');
  assert.equal(where('New York City Office'), 'office');
});

test('"NYC" means the whole city, not just the string', () => {
  const nycOnly = { allow: ['NYC'] };
  for (const l of ['Brooklyn, NY', 'Queens, New York', 'Long Island City, NY', 'Manhattan', 'New York, NY']) {
    assert.equal(classifyLocation(l, nycOnly), 'office', l);
  }
  assert.equal(classifyLocation('Yonkers, NY', nycOnly), 'other');
});

test('a leading country does not make a state-level posting remote', () => {
  assert.equal(where('United States, Utah, USA'), 'other');
  assert.equal(where('United States · Canada'), 'remote', 'with no US city or state named, it is still remote');
});
