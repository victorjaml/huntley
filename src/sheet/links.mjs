// Signed action links.
//
// An email can only ever do one thing: a GET. So "Add" and "APPROVE" are links.
// That raises the obvious question — what stops anyone who sees the link from
// writing to your tracker? An HMAC.
//
// Each link carries the action, the target, an expiry, the role's details, and a
// signature over all of them, keyed by a secret shared between huntley and the
// Apps Script endpoint. The details are signed because the endpoint writes them
// into your tracker: unsigned, anyone holding a valid link could swap in a
// different apply URL before it expired.
// The endpoint recomputes the signature and refuses anything that does not
// match or has expired. Nobody needs inbox access, no inbound port is opened on
// a server, and a forwarded email cannot be used to write to your sheet
// after the link expires.
//
// The endpoint is a Google Apps Script web app bound to your tracker sheet
// (apps-script/Code.gs). It appends the row and shows a confirmation page.
// huntley reads the sheet back on the next run — the flow is pull-only, which
// is why nothing has to listen on your network.

import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The detail params a link may carry, in signing order: company, title, url, location, source. */
export const DETAIL_KEYS = ['c', 't', 'u', 'l', 's'];
const DETAIL_MAX = 200;

/**
 * The exact string both sides sign. Order is part of the contract.
 * Each detail is percent-encoded, so no value can contain the separator and
 * shift text from one field into the next; an absent detail signs as empty.
 */
export function signingPayload({ action, id, exp, details = {} }) {
  const d = DETAIL_KEYS.map((k) => encodeURIComponent(details[k] ?? '')).join(' ');
  return `${action} ${id} ${exp} ${d}`;
}

export function sign(payload, secret) {
  return b64url(createHmac('sha256', String(secret)).update(payload).digest());
}

/**
 * Verify a signature in constant time. Exported so the test suite can prove the
 * Apps Script's logic and huntley's agree.
 */
export function verify({ action, id, exp, details = {} }, signature, secret, now = Date.now()) {
  const expected = sign(signingPayload({ action, id, exp, details }), secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature ?? ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  if (Number(exp) * 1000 < now) return { ok: false, reason: 'link expired' };
  return { ok: true };
}

/**
 * Build a signed action URL.
 *
 * @param {object} opts
 * @param {string} opts.endpoint  the Apps Script web app /exec URL
 * @param {string} opts.secret    HUNTLEY_LINK_SECRET, shared with the script
 * @param {string} opts.action    'add' | 'approve' | 'ignore'
 * @param {string} opts.id        job id, or proposal id for 'approve'
 * @param {number} [opts.ttlDays]
 * @param {object} [opts.extra]   role details written to the tracker: c company, t title,
 *                                 u url, l location, s source. Signed; anything else is dropped.
 */
export function actionUrl({ endpoint, secret, action, id, ttlDays = DEFAULT_TTL_DAYS, extra = {} }) {
  if (!endpoint) throw new Error('sheet.webapp_url is not configured — Add links cannot be built');
  if (!secret) throw new Error('HUNTLEY_LINK_SECRET is not set — Add links cannot be signed');

  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86_400;
  // A detail too long for a link is left out, and signed as absent.
  const details = {};
  for (const k of DETAIL_KEYS) {
    const v = extra[k];
    if (v != null && String(v) !== '' && String(v).length <= DETAIL_MAX) details[k] = String(v);
  }
  const sig = sign(signingPayload({ action, id, exp, details }), secret);

  const url = new URL(endpoint);
  url.searchParams.set('a', action);
  url.searchParams.set('id', id);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);

  for (const [k, v] of Object.entries(details)) url.searchParams.set(k, v);
  return url.toString();
}

export { DEFAULT_TTL_DAYS };
