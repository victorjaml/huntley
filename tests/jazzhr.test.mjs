import test from 'node:test';
import assert from 'node:assert/strict';
import provider, { parseBoard, detect } from '../src/sources/providers/jazzhr.mjs';

// A trimmed copy of the real markup, so the parser is tested without a network
// call and a future markup change fails here rather than in production.
const BOARD = `<html><body>
<ul class="list-group">
  <li class="list-group-item">
    <h3 class='list-group-item-heading'>
      <a href="https://acme.applytojob.com/apply/imNANfIn9x/Senior-ML-Engineer"> Senior ML Engineer </a>
    </h3>
    <ul class='list-inline list-group-item-text'>
      <li><i class='fa fa-map-marker'></i>Los Angeles, CA</li>
      <li><i class='fa fa-briefcase'></i>Engineering</li>
    </ul>
  </li>
  <li class="list-group-item">
    <h3 class='list-group-item-heading'>
      <a href="http://acme.applytojob.com/apply/0Do59ITmS0/Data-Engineer-R-amp-D">Data Engineer, R&amp;D</a>
    </h3>
    <ul class='list-inline list-group-item-text'>
      <li><i class='fa fa-map-marker'></i>Remote</li>
    </ul>
  </li>
</ul></body></html>`;

test('the board parser extracts title, url and location', () => {
  const jobs = parseBoard(BOARD);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    title: 'Senior ML Engineer',
    url: 'https://acme.applytojob.com/apply/imNANfIn9x/Senior-ML-Engineer',
    location: 'Los Angeles, CA',
    postedAt: null,
  });
});

test('entities are decoded and http is upgraded to https', () => {
  const jobs = parseBoard(BOARD);
  assert.equal(jobs[1].title, 'Data Engineer, R&D');
  assert.match(jobs[1].url, /^https:/);
});

test('only the map-marker row is read as the location', () => {
  assert.equal(parseBoard(BOARD)[0].location, 'Los Angeles, CA', 'the department row is not mistaken for a location');
});

test('a block with no link or no title is skipped rather than half-emitted', () => {
  const jobs = parseBoard(`<ul>
    <li class="list-group-item"><h3 class='list-group-item-heading'><a href="https://acme.applytojob.com/apply/x/Good">Good</a></h3></li>
    <li class="list-group-item"><h3 class='list-group-item-heading'>No link here</h3></li>
    <li class="list-group-item"><h3 class='list-group-item-heading'><a href="https://elsewhere.test/x"> Offsite </a></h3></li>
  </ul>`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Good');
});

test('markup that changed shape throws instead of reporting an empty board', () => {
  // A silent zero is indistinguishable from "this company has no openings",
  // which is exactly the failure that would go unnoticed for months.
  assert.throws(() => parseBoard('<ul><li class="list-group-item"><div>new markup</div></li></ul>'), /markup may have changed/);
});

test('a genuinely empty board returns nothing without throwing', () => {
  assert.deepEqual(parseBoard('<html><body><p>No openings right now.</p></body></html>'), []);
});

test('detect recognizes a JazzHR host and rejects others', () => {
  assert.deepEqual(detect({ careers_url: 'https://acme.applytojob.com/apply' }), { url: 'https://acme.applytojob.com/apply' });
  assert.equal(detect({ careers_url: 'https://boards.greenhouse.io/acme' }), null);
  assert.equal(detect({}), null);
});

test('an explicit jazzhr_slug covers a branded careers page', () => {
  assert.deepEqual(
    detect({ careers_url: 'https://acme.com/careers', jazzhr_slug: 'acme' }),
    { url: 'https://acme.applytojob.com/apply' },
  );
});

test('the provider satisfies the career-ops contract', () => {
  assert.equal(provider.id, 'jazzhr');
  assert.equal(typeof provider.fetch, 'function');
  assert.equal(typeof provider.detect, 'function');
});
