/**
 * huntley — tracker endpoint.
 *
 * A Google Apps Script web app bound to your tracker spreadsheet. It is the
 * click target for the Add buttons in each digest and for the APPROVE link in
 * the weekly preference proposal.
 *
 * Why this instead of a server:
 *   • email can only ever issue a GET, so the control has to be a link
 *   • nothing has to listen on your home network — no port, no tunnel, no TLS
 *   • the script is already authenticated to your sheet, so there is no
 *     service-account key sitting on disk
 *   • it works from your phone, on any network, months after the mail arrived
 *
 * Security model: every link carries (action, id, expiry) and an HMAC-SHA256
 * signature over exactly "action id exp", keyed by a secret shared with
 * huntley. This script recomputes the signature and refuses anything that does
 * not match or has expired. The display parameters (company, title, url) are
 * NOT signed and are treated as untrusted text — they are written to the sheet
 * escaped and never evaluated.
 *
 * SETUP: see docs/google-sheets-setup.md. In short —
 *   1. Extensions › Apps Script from your tracker sheet
 *   2. paste this file
 *   3. Project Settings › Script Properties: HUNTLEY_LINK_SECRET = <same value
 *      as in your .env>
 *   4. Deploy › New deployment › Web app; execute as Me; access Anyone
 *   5. paste the /exec URL into config/huntley.yml as sheet.webapp_url
 */

const TAB_INBOX = 'Inbox';
const TAB_APPLICATIONS = 'Applications';
const TAB_APPROVALS = 'Approvals';

const INBOX_HEADERS = ['added_at', 'job_id', 'company', 'title', 'url', 'status'];
const APPLICATION_HEADERS = [
  'added_at', 'job_id', 'company', 'title', 'url', 'location', 'source',
  'status', 'applied_at', 'last_update', 'outcome', 'notes',
];
const APPROVAL_HEADERS = ['approved_at', 'proposal_id', 'status'];

/** Entry point. Every action link lands here. */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.a || '');
    const id = String(p.id || '');
    const exp = String(p.exp || '');
    const sig = String(p.sig || '');

    const check = verify_(action, id, exp, sig, p);
    if (!check.ok) return page_('Not accepted', check.reason, false);

    if (action === 'add') return handleAdd_(id, p);
    if (action === 'approve') return handleApprove_(id);
    if (action === 'ignore') return handleIgnore_(id, p);

    return page_('Not accepted', 'Unknown action.', false);
  } catch (err) {
    return page_('Something went wrong', String(err), false);
  }
}

// ── Signature verification ──────────────────────────────────────────

function secret_() {
  const s = PropertiesService.getScriptProperties().getProperty('HUNTLEY_LINK_SECRET');
  if (!s) throw new Error('HUNTLEY_LINK_SECRET is not set in this script’s Script Properties.');
  return s;
}

/** base64url, matching Node's Buffer.toString('base64url'). */
function b64url_(bytes) {
  return Utilities.base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign_(payload) {
  return b64url_(Utilities.computeHmacSha256Signature(payload, secret_()));
}

/** Constant-time-ish comparison. Apps Script has no timingSafeEqual. */
function equals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The role details a link carries, in signing order. They are written into the
 * tracker, so they are signed: otherwise anyone holding a valid link could
 * change the apply URL before it expired. Percent-encoding keeps any value from
 * containing the separator; an absent detail signs as empty.
 */
const DETAIL_KEYS = ['c', 't', 'u', 'l', 's'];

function detailPayload_(p) {
  return DETAIL_KEYS.map(function (k) { return encodeURIComponent(String(p[k] || '')); }).join(' ');
}

function verify_(action, id, exp, sig, p) {
  if (!action || !id || !exp || !sig) return { ok: false, reason: 'This link is incomplete.' };
  // The payload format is a contract shared with src/sheet/links.mjs. If you
  // change it here, change it there — the test suite asserts both agree.
  if (!equals_(sign_(action + ' ' + id + ' ' + exp + ' ' + detailPayload_(p)), sig)) {
    return { ok: false, reason: 'This link’s signature is not valid. It may have been altered in transit.' };
  }
  if (Number(exp) * 1000 < Date.now()) {
    return { ok: false, reason: 'This link has expired. Run huntley again to get a fresh one.' };
  }
  return { ok: true };
}

// ── Sheet helpers ───────────────────────────────────────────────────

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

/** Find the 1-based row whose job_id column matches, or 0. */
function findRowByJobId_(sh, jobId, idColumn) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, idColumn, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === jobId) return i + 2;
  }
  return 0;
}

/**
 * Sheets treats a leading =, +, -, or @ as a formula. Job titles genuinely
 * start with "+" ("C++ Engineer"), and an untrusted company name must never be
 * able to become a formula, so every written cell is prefixed when it would.
 */
function safeText_(value) {
  const s = String(value == null ? '' : value).slice(0, 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// ── Actions ─────────────────────────────────────────────────────────

function handleAdd_(jobId, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const applications = sheet_(TAB_APPLICATIONS, APPLICATION_HEADERS);

    // Idempotent: the same link clicked twice, or clicked on two devices, must
    // not produce two tracker rows.
    const existing = findRowByJobId_(applications, jobId, 2);
    if (existing) {
      return page_('Already on your tracker',
        safeText_(p.t || '') + (p.c ? ' at ' + safeText_(p.c) : '') + ' is already there — nothing changed.', true, p.u);
    }

    const now = new Date();
    applications.appendRow([
      now,                      // added_at
      jobId,                    // job_id
      safeText_(p.c || ''),     // company
      safeText_(p.t || ''),     // title
      safeText_(p.u || ''),     // url
      safeText_(p.l || ''),     // location
      safeText_(p.s || ''),     // source
      'To apply',               // status — NOT "applied". You apply yourself.
      '',                       // applied_at
      now,                      // last_update
      '',                       // outcome
      '',                       // notes
    ]);

    // The inbox is huntley's read-back channel: `huntley sync` reads this tab
    // to learn which roles you added, which is the calibration signal the
    // weekly review depends on.
    sheet_(TAB_INBOX, INBOX_HEADERS).appendRow([
      now, jobId, safeText_(p.c || ''), safeText_(p.t || ''), safeText_(p.u || ''), 'added',
    ]);

    return page_('Added to your tracker',
      safeText_(p.t || 'This role') + (p.c ? ' at ' + safeText_(p.c) : '') +
      ' is on your tracker with status “To apply”. huntley has not applied — you do that yourself.', true, p.u);
  } finally {
    lock.releaseLock();
  }
}

function handleIgnore_(jobId, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    sheet_(TAB_INBOX, INBOX_HEADERS).appendRow([
      new Date(), jobId, safeText_(p.c || ''), safeText_(p.t || ''), safeText_(p.u || ''), 'ignored',
    ]);
    return page_('Noted', 'huntley will weigh this against similar roles in the weekly review.', true);
  } finally {
    lock.releaseLock();
  }
}

function handleApprove_(proposalId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(TAB_APPROVALS, APPROVAL_HEADERS);
    if (findRowByJobId_(sh, proposalId, 2)) {
      return page_('Already approved', 'This proposal was already approved. huntley will apply it on its next run.', true);
    }
    sh.appendRow([new Date(), proposalId, 'approved']);
    return page_('Approved',
      'huntley will apply this change to your preference memory on its next run, and the next digest will say that it did.', true);
  } finally {
    lock.releaseLock();
  }
}

// ── Confirmation page ───────────────────────────────────────────────

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page_(title, message, ok, jobUrl) {
  const accent = ok ? '#15803d' : '#b91c1c';
  // Only http(s) links are ever rendered — a javascript: url in an unsigned
  // parameter must not become a clickable link on this page.
  const safeLink = jobUrl && /^https?:\/\//i.test(String(jobUrl)) ? String(jobUrl) : '';

  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>huntley</title></head>' +
    '<body style="margin:0;background:#f7f8fa;font:16px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#16181d;">' +
    '<div style="max-width:520px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;">' +
    '<div style="font:600 11px/1 -apple-system,sans-serif;color:#9aa1ac;letter-spacing:.14em;text-transform:uppercase;">huntley</div>' +
    '<h1 style="font-size:21px;margin:14px 0 8px;color:' + accent + ';">' + escapeHtml_(title) + '</h1>' +
    '<p style="margin:0;color:#4b5563;">' + escapeHtml_(message) + '</p>' +
    (safeLink
      ? '<p style="margin:20px 0 0;"><a href="' + escapeHtml_(safeLink) + '" style="color:#1f5fd6;">Open the posting →</a></p>'
      : '') +
    '<p style="margin:22px 0 0;font-size:13px;color:#9aa1ac;">You can close this tab.</p>' +
    '</div></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('huntley')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ── Setup helper ────────────────────────────────────────────────────

/**
 * Run once from the Apps Script editor to create the three tabs with headers
 * before your first digest, so the sheet is readable from the start.
 */
function setUpTabs() {
  sheet_(TAB_APPLICATIONS, APPLICATION_HEADERS);
  sheet_(TAB_INBOX, INBOX_HEADERS);
  sheet_(TAB_APPROVALS, APPROVAL_HEADERS);
  SpreadsheetApp.getActiveSpreadsheet().toast('huntley tabs are ready.');
}
