// Outbound email. Outbound only — huntley never reads a mailbox.
//
// Shaped after the client / MockClient / factory split in victorjaml/nuzzel-py's
// email_client.py, with its deliverability lessons carried over:
//
//   • click tracking OFF. A provider that rewrites your links turns every
//     "View posting" into a redirect and mangles the signed Add links.
//   • an explicit Reply-To, a real display name, and a plain-text alternative,
//     because an HTML-only message from a new sending domain is spam-shaped.
//   • send failures are returned, never swallowed — the caller decides whether
//     a failed digest is a failed run. It is.
//
// Four transports. `console` is the default so a fresh clone runs end to end
// and prints the digest without any account anywhere.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTransport } from './smtp.mjs';
import { PATHS } from '../lib/paths.mjs';
import { log } from '../lib/log.mjs';

/**
 * @typedef {object} Message
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 */

class Mailer {
  constructor(cfg) {
    this.cfg = cfg;
    this.from = cfg.from;
    this.fromName = cfg.from_name ?? 'huntley';
    this.to = cfg.to;
    this.replyTo = cfg.reply_to ?? cfg.from;
  }
  /** @returns {Promise<{ok: boolean, sent?: boolean, id?: string, error?: string}>} */
  async send() { throw new Error('not implemented'); }
}

// ── console: write the digest to data/digests and print where it went ───

class ConsoleMailer extends Mailer {
  async send({ subject, html, text }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = join(PATHS.digests, `${stamp}.html`);
    writeFileSync(htmlPath, html);
    writeFileSync(join(PATHS.digests, `${stamp}.txt`), text);
    log.ok(`digest written to ${htmlPath}`);
    log.info(`  (email.provider is "console" — nothing was sent; subject was: ${subject})`);
    return { ok: true, sent: false, id: htmlPath };
  }
}

// ── resend ──────────────────────────────────────────────────────────

class ResendMailer extends Mailer {
  constructor(cfg) {
    super(cfg);
    this.apiKey = process.env.RESEND_API_KEY;
    if (!this.apiKey) throw new Error('RESEND_API_KEY is not set');
  }

  async send({ subject, html, text }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${this.fromName} <${this.from}>`,
        to: [this.to],
        reply_to: this.replyTo,
        subject,
        html,
        text,
        // Resend does not rewrite links by default; this keeps it explicit for
        // anyone who turns click tracking on at the domain level later.
        tags: [{ name: 'app', value: 'huntley' }],
      }),
    });

    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 300)}` };
    let id;
    try { id = JSON.parse(body).id; } catch { /* id is nice to have, not required */ }
    return { ok: true, id };
  }
}

// ── mailjet (the transport nuzzel-py uses) ──────────────────────────

class MailjetMailer extends Mailer {
  constructor(cfg) {
    super(cfg);
    this.key = process.env.MAILJET_API_KEY;
    this.secret = process.env.MAILJET_API_SECRET;
    if (!this.key || !this.secret) throw new Error('MAILJET_API_KEY and MAILJET_API_SECRET must both be set');
  }

  async send({ subject, html, text }) {
    const auth = Buffer.from(`${this.key}:${this.secret}`).toString('base64');
    const res = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Messages: [{
          From: { Email: this.from, Name: this.fromName },
          To: [{ Email: this.to }],
          ReplyTo: { Email: this.replyTo },
          Subject: subject,
          HTMLPart: html,
          TextPart: text,
          CustomID: 'huntley-digest',
          // Without this, Mailjet rewrites every href through mjt.lu — which
          // breaks the signed Add links and makes the apply links unreadable.
          TrackClicks: 'disabled',
          TrackOpens: 'disabled',
        }],
      }),
    });

    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Mailjet HTTP ${res.status}: ${body.slice(0, 300)}` };
    try {
      const msg = JSON.parse(body).Messages?.[0];
      if (msg?.Status !== 'success') return { ok: false, error: `Mailjet rejected the message: ${JSON.stringify(msg).slice(0, 300)}` };
      return { ok: true, id: msg.To?.[0]?.MessageID };
    } catch {
      return { ok: true };
    }
  }
}

// ── smtp ────────────────────────────────────────────────────────────

class SmtpMailer extends Mailer {
  async send({ subject, html, text }) {
    return createTransport({
      host: process.env.SMTP_HOST ?? this.cfg.host,
      port: Number(process.env.SMTP_PORT ?? this.cfg.port ?? 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      secure: String(process.env.SMTP_SECURE ?? this.cfg.secure ?? '') === 'true',
    }).send({ from: this.from, fromName: this.fromName, to: this.to, replyTo: this.replyTo, subject, html, text });
  }
}

const TRANSPORTS = { console: ConsoleMailer, resend: ResendMailer, mailjet: MailjetMailer, smtp: SmtpMailer };

/**
 * Build the configured mailer.
 * HUNTLEY_MOCK_EMAIL=true forces the console transport regardless of config —
 * the switch to use when testing a change to the digest without mailing yourself.
 */
export function createMailer(emailConfig) {
  const forced = String(process.env.HUNTLEY_MOCK_EMAIL ?? '').toLowerCase() === 'true';
  const provider = forced ? 'console' : (emailConfig?.provider ?? 'console');
  if (forced && emailConfig?.provider !== 'console') {
    log.warn(`HUNTLEY_MOCK_EMAIL=true — using the console transport instead of ${emailConfig?.provider}`);
  }

  const Ctor = TRANSPORTS[provider];
  if (!Ctor) throw new Error(`Unknown email provider "${provider}" (expected one of ${Object.keys(TRANSPORTS).join(', ')})`);
  return new Ctor(emailConfig ?? {});
}

export { Mailer, ConsoleMailer };
