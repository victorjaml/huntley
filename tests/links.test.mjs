import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { actionUrl, sign, verify, signingPayload, DETAIL_KEYS } from '../src/sheet/links.mjs';

const detailsOf = (p) => Object.fromEntries(DETAIL_KEYS.filter((k) => p[k] != null).map((k) => [k, p[k]]));

const SECRET = 'test-secret-value';

test('a signed link round-trips', () => {
  const url = new URL(actionUrl({
    endpoint: 'https://script.google.com/macros/s/AKfy/exec',
    secret: SECRET, action: 'add', id: 'abc123',
  }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(verify({ action: p.a, id: p.id, exp: p.exp, details: detailsOf(p) }, p.sig, SECRET).ok, true);
});

test('a tampered job id invalidates the signature', () => {
  const url = new URL(actionUrl({ endpoint: 'https://x.test/exec', secret: SECRET, action: 'add', id: 'abc123' }));
  const p = Object.fromEntries(url.searchParams);
  const res = verify({ action: p.a, id: 'OTHER', exp: p.exp }, p.sig, SECRET);
  assert.equal(res.ok, false);
  assert.match(res.reason, /signature/);
});

test('a link signed with a different secret is refused', () => {
  const url = new URL(actionUrl({ endpoint: 'https://x.test/exec', secret: SECRET, action: 'add', id: 'abc' }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(verify({ action: p.a, id: p.id, exp: p.exp }, p.sig, 'wrong-secret').ok, false);
});

test('an expired link is refused even with a valid signature', () => {
  const exp = Math.floor(Date.now() / 1000) - 60;
  const sig = sign(signingPayload({ action: 'add', id: 'abc', exp }), SECRET);
  const res = verify({ action: 'add', id: 'abc', exp }, sig, SECRET);
  assert.equal(res.ok, false);
  assert.match(res.reason, /expired/);
});

test('an "add" signature cannot be replayed as an "approve"', () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = sign(signingPayload({ action: 'add', id: 'p1', exp }), SECRET);
  assert.equal(verify({ action: 'approve', id: 'p1', exp }, sig, SECRET).ok, false);
});

test('the role details written to the tracker are signed, so a link cannot be edited to point elsewhere', () => {
  const url = new URL(actionUrl({
    endpoint: 'https://x.test/exec', secret: SECRET, action: 'add', id: 'abc',
    extra: { c: 'Acme', t: 'ML Engineer', u: 'https://job-boards.greenhouse.io/acme/jobs/1', other: 'dropped' },
  }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(p.other, undefined, 'only the known details are carried');
  assert.equal(verify({ action: p.a, id: p.id, exp: p.exp, details: detailsOf(p) }, p.sig, SECRET).ok, true);

  for (const [k, v] of [['u', 'https://evil.test/apply'], ['c', 'Other Co'], ['t', 'ML Engineer '], ['l', 'Remote']]) {
    assert.equal(verify({ action: p.a, id: p.id, exp: p.exp, details: { ...detailsOf(p), [k]: v } }, p.sig, SECRET).ok, false, `changing ${k} must break the signature`);
  }
});

test('a value cannot move text between details to keep a signature valid', () => {
  const exp = 9;
  const a = signingPayload({ action: 'add', id: 'x', exp, details: { c: 'Acme Labs', t: 'Engineer' } });
  const b = signingPayload({ action: 'add', id: 'x', exp, details: { c: 'Acme', t: 'Labs Engineer' } });
  assert.notEqual(a, b);
  assert.equal(signingPayload({ action: 'approve', id: 'p1', exp: 9 }), 'approve p1 9     ', 'an approve link signs five empty details');
});

test('a detail too long for a link is left out and signed as absent', () => {
  const url = new URL(actionUrl({ endpoint: 'https://x.test/exec', secret: SECRET, action: 'add', id: 'abc', extra: { t: 'x'.repeat(201), c: 'Acme' } }));
  const p = Object.fromEntries(url.searchParams);
  assert.equal(p.t, undefined);
  assert.equal(verify({ action: p.a, id: p.id, exp: p.exp, details: detailsOf(p) }, p.sig, SECRET).ok, true);
});

test('links cannot be built without an endpoint or a secret', () => {
  assert.throws(() => actionUrl({ secret: SECRET, action: 'add', id: 'a' }), /webapp_url/);
  assert.throws(() => actionUrl({ endpoint: 'https://x.test/exec', action: 'add', id: 'a' }), /LINK_SECRET/);
});

// ── The contract with Apps Script ──────────────────────────────────
// Code.gs cannot import from src/, so the two implementations of the signature
// are separate code. This test is what keeps them from drifting apart — a
// drift would break every Add button with no error anywhere.

test('the Apps Script verifier signs the identical payload as huntley', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

  // Code.gs builds the payload as: action id exp, then each detail percent-encoded, space-separated.
  assert.match(gs, /sign_\(action \+ ' ' \+ id \+ ' ' \+ exp \+ ' ' \+ detailPayload_\(p\)\)/,
    'Code.gs must sign "action id exp details" — the same string signingPayload() builds');
  assert.match(gs, new RegExp(`const DETAIL_KEYS = \\[${DETAIL_KEYS.map((k) => `'${k}'`).join(', ')}\\];`),
    'Code.gs must list the same details in the same order');
  assert.match(gs, /DETAIL_KEYS\.map\(function \(k\) \{ return encodeURIComponent\(String\(p\[k\] \|\| ''\)\); \}\)\.join\(' '\)/,
    'Code.gs must percent-encode each detail, empty when absent, joined by single spaces');
  assert.equal(signingPayload({ action: 'add', id: 'x', exp: 9, details: { c: 'A&B Co', u: 'https://x.test/1?a=b' } }),
    'add x 9 A%26B%20Co  https%3A%2F%2Fx.test%2F1%3Fa%3Db  ');

  // …HMAC-SHA256, base64url, padding stripped, matching Node's 'base64url'.
  assert.match(gs, /computeHmacSha256Signature/);
  assert.match(gs, /replace\(\/\\\+\/g, '-'\)\.replace\(\/\\\/\/g, '_'\)\.replace\(\/=\+\$\/, ''\)/,
    'Code.gs must convert base64 to base64url exactly as Buffer.toString("base64url") does');

  // Prove the encoding agrees on a value that actually contains + and /.
  const raw = createHmac('sha256', SECRET).update('add x 9').digest();
  const nodeStyle = raw.toString('base64url');
  const gsStyle = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(nodeStyle, gsStyle);
  assert.equal(sign('add x 9', SECRET), nodeStyle);
});

test('Code.gs refuses to write a cell that Sheets would evaluate as a formula', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(gs, /\/\^\[=\+\\-@\]\/\.test\(s\)/, 'safeText_ must guard =, +, - and @');
  assert.match(gs, /safeText_\(p\.c/, 'the company cell must go through safeText_');
  assert.match(gs, /safeText_\(p\.t/, 'the title cell must go through safeText_');
});

test('Code.gs only renders http(s) links on its confirmation page', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(gs, /\^https\?:\\\/\\\//, 'a javascript: url must never become a clickable link');
});

test('Code.gs records an Add as an intent, never as a submitted application', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(gs, /'To apply',\s*\/\/ status/, 'the tracker status on Add must be "To apply"');
  assert.ok(!/'Applied'/.test(gs), 'nothing in the endpoint may mark a role as applied');
});
