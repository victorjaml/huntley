import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTitle } from '../src/rank/title-match.mjs';
import { scannerTitleTerms } from '../src/sources/watchlist.mjs';
import { buildTitleFilter } from '../src/sources/boards/title-keywords.mjs';

const targets = {
  role_terms: ['engineer*', 'scientist*', 'researcher*', 'technical staff', 'research manager'],
  title_keywords: ['ai safety', 'safety', 'research', 'machine learning', 'ml', 'ai', 'rl', 'post training', 'evaluation*', 'robotics', 'perception', 'engineering manager'],
  exclude_titles: ['mechanical engineer', 'rocket scientist', 'intern', 'hardware*'],
};
const m = (title) => matchTitle(title, targets);

// ── The rule, as stated ─────────────────────────────────────────────

test('a title needs a role word to be considered', () => {
  assert.deepEqual(m('Research Engineer').roles, ['engineer*']);
  assert.deepEqual(m('Account Executive').roles, []);
});

test('each keyword adds a point: more specific scores higher', () => {
  assert.equal(m('Software Engineer, Notifications').score, 0);
  assert.equal(m('Machine Learning Engineer').score, 1);
  assert.equal(m('AI Safety Research Engineer').score, 2, 'ai safety + research');
  assert.deepEqual(m('AI Safety Research Engineer').keywords, ['ai safety', 'research']);
});

test('the wrong kind of engineer or scientist is excluded', () => {
  assert.deepEqual(m('Senior Robotics Mechanical Engineer').excluded, ['mechanical engineer']);
  assert.deepEqual(m('Rocket Scientist').excluded, ['rocket scientist']);
  assert.deepEqual(m('Perception Hardware Engineer').excluded, ['hardware*']);
});

// ── Matching rules ──────────────────────────────────────────────────

test('matching is on whole words, so short keywords do not fire inside others', () => {
  assert.equal(m('HTML Email Engineer').keywords.includes('ml'), false, 'ml is not in HTML');
  assert.equal(m('Maintenance Engineer').keywords.includes('ai'), false, 'ai is not in Maintenance');
  assert.equal(m('World Model Engineer').keywords.includes('rl'), false, 'rl is not in World');
  assert.equal(m('Internal Tools Engineer').excluded.length, 0, 'intern does not exclude Internal');
  assert.equal(m('Senior ML Engineer').keywords.includes('ml'), true);
});

test('a trailing * matches the start of a word', () => {
  assert.deepEqual(m('Engineering Manager, Platform').roles, ['engineer*'], 'engineer* covers Engineering');
  assert.equal(m('Member of Technical Staff - Evaluations').keywords.includes('evaluation*'), true);
  assert.deepEqual(m('AI Security Researchers').roles, ['researcher*']);
});

test('a space in a term also matches a hyphen or slash', () => {
  assert.equal(m('Research Engineer, Post-Training').keywords.includes('post training'), true);
  assert.equal(m('Research Engineer/Scientist').roles.length, 2);
});

test('member of technical staff matches with or without "the"', () => {
  assert.deepEqual(m('Member of Technical Staff').roles, ['technical staff']);
  assert.deepEqual(m('Member of the Technical Staff, Safety').roles, ['technical staff']);
});

test('overlapping keywords count once, longest first', () => {
  // "ai safety", "safety" and "ai" all appear in the list; the title states one idea.
  const r = m('AI Safety Engineer');
  assert.deepEqual(r.keywords, ['ai safety']);
  assert.equal(r.score, 1, 'writing the same idea three times in config must not triple the score');
});

test('a keyword appearing twice in a title counts once', () => {
  assert.equal(m('Research Engineer, Research Infrastructure').score, 1);
});

test('the management lane passes without an engineer word', () => {
  assert.deepEqual(m('Research Manager').roles, ['research manager']);
  assert.equal(m('Machine Learning Engineering Manager').score, 2, 'machine learning + engineering manager');
});

test('matching is case-insensitive and tolerates empty input', () => {
  assert.equal(m('RESEARCH ENGINEER').score, 1);
  assert.deepEqual(matchTitle('', targets), { excluded: [], roles: [], keywords: [], groups: [], score: 0 });
  assert.deepEqual(matchTitle(null, {}), { excluded: [], roles: [], keywords: [], groups: [], score: 0 });
});

// ── The scanner never drops what huntley would keep ─────────────────
// career-ops filters BEFORE huntley sees anything, with its own matcher. If its
// filter is ever narrower than huntley's, roles vanish with no record. These
// assert the superset relationship on real title shapes.

const TITLES = [
  'AI Safety Research Engineer', 'Member of the Technical Staff, Safety', 'Research Engineer/Scientist',
  'AI Security Researcher', 'Research Manager', 'Engineering Manager, Machine Learning',
  'Internal Tools Engineer', 'International Research Scientist', 'Research Engineer, Post-Training',
  'Senior Robotics Mechanical Engineer', 'Perception Hardware Engineer', 'Rocket Scientist',
  'Operations Intern', 'Account Executive', 'Software Engineer, Notifications', 'Hardwareless Engineer',
];

test('everything huntley keeps, the scanner keeps', () => {
  const scanner = buildTitleFilter(scannerTitleTerms(targets));
  for (const title of TITLES) {
    const r = m(title);
    const huntleyKeeps = r.excluded.length === 0 && r.roles.length > 0;
    if (huntleyKeeps) {
      assert.equal(scanner(title), true, `the scanner would silently drop "${title}", which huntley keeps`);
    }
  }
});

test('scanner exclusions are word-anchored, so "intern" cannot drop "Internal"', () => {
  const { negative } = scannerTitleTerms(targets);
  assert.ok(negative.includes('word:intern'));
  assert.ok(negative.includes('stem:hardware'));
  const scanner = buildTitleFilter(scannerTitleTerms(targets));
  assert.equal(scanner('Internal Tools Engineer'), true);
  assert.equal(scanner('Operations Intern'), false);
});

// ── Exclusion exceptions ────────────────────────────────────────────

const swe = {
  role_terms: ['engineer*'],
  title_keywords: ['machine learning'],
  exclude_titles: ['software engineer', 'forward deployed*', 'security'],
  exclude_exceptions: { 'software engineer': ['staff'] },
};

test('an exception protects the exclusion inside it, and only that', () => {
  assert.deepEqual(matchTitle('Senior Software Engineer', swe).excluded, ['software engineer']);
  assert.deepEqual(matchTitle('Staff Software Engineer', swe).excluded, []);
  assert.deepEqual(matchTitle('Senior Staff Software Engineer, Perception', swe).excluded, []);
  assert.deepEqual(matchTitle('Staff Software Engineer, Security', swe).excluded, ['security'],
    'an exception does not rescue a second, unrelated exclusion in the same title');
});

test('exception words count anywhere in the title, because level words move', () => {
  assert.deepEqual(matchTitle('Senior Staff AI Software Engineer, Perception', swe).excluded, []);
  assert.deepEqual(matchTitle('Member of Technical Staff - Research Software Engineer', swe).excluded, []);
});

test('an exception cancels only its own exclusion', () => {
  const t = { ...swe, exclude_titles: [...swe.exclude_titles, 'intern'] };
  assert.deepEqual(matchTitle('Staff Software Engineer Intern', t).excluded, ['intern'],
    '"staff" cancels the software-engineer exclusion, not every exclusion');
});

test('a stem exclusion covers every form of the phrase', () => {
  assert.deepEqual(matchTitle('Forward Deployed Engineer', swe).excluded, ['forward deployed*']);
  assert.deepEqual(matchTitle('Forward Deployed Research Scientist', swe).excluded, ['forward deployed*']);
});

test('the scanner is not sent an exclusion an exception protects', () => {
  const { negative } = scannerTitleTerms(swe);
  assert.equal(negative.includes('word:software engineer'), false,
    'career-ops has no exceptions, so it would drop Staff Software Engineer before huntley saw it');
  assert.ok(negative.includes('stem:forward deployed'), 'unprotected exclusions still go to the scanner');
  const scanner = buildTitleFilter(scannerTitleTerms(swe));
  assert.equal(scanner('Staff Software Engineer'), true);
  assert.equal(scanner('Forward Deployed Engineer'), false);
});

// ── Keyword groups and @group exceptions ────────────────────────────

const grouped = {
  role_terms: ['engineer*'],
  title_keywords: {
    safety: ['ai safety', 'alignment', 'safety'],
    robotics: ['robotics', 'perception', 'manipulation'],
    ml: ['machine learning'],
  },
  exclude_titles: ['software engineer'],
  exclude_exceptions: { 'software engineer': ['staff', '@safety', '@robotics'] },
};

test('grouped keywords score exactly like a flat list', () => {
  const flat = { ...grouped, title_keywords: ['ai safety', 'alignment', 'safety', 'robotics', 'perception', 'manipulation', 'machine learning'] };
  for (const title of ['Robotics Machine Learning Engineer', 'AI Safety Engineer', 'Perception Engineer, Manipulation']) {
    assert.equal(matchTitle(title, grouped).score, matchTitle(title, flat).score, title);
  }
  assert.deepEqual(matchTitle('Robotics Machine Learning Engineer', grouped).groups, ['robotics', 'ml']);
});

test('an @group exception keeps below-staff software roles in that area', () => {
  assert.deepEqual(matchTitle('Robotics Software Engineer III, Manipulation', grouped).excluded, []);
  assert.deepEqual(matchTitle('Senior Safety Software Engineer', grouped).excluded, []);
  assert.deepEqual(matchTitle('Staff Software Engineer, Payments', grouped).excluded, []);
  assert.deepEqual(matchTitle('Machine Learning Software Engineer', grouped).excluded, ['software engineer'],
    'core ML is not in an exception group, so below-staff software roles there stay out');
  assert.deepEqual(matchTitle('Senior Software Engineer, Payments', grouped).excluded, ['software engineer']);
});
