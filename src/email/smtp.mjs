// SMTP transport.
//
// Hand-rolling SMTP means hand-rolling STARTTLS negotiation, AUTH mechanism
// selection, MIME multipart assembly and quoted-printable encoding — four
// places to get something subtly wrong that only shows up as a digest that
// silently never arrives. nodemailer does all four correctly, so SMTP users get
// it as an optional dependency and everyone else pays nothing for it.
//
//   npm install nodemailer
//
// The Resend, Mailjet and console transports need nothing extra.

/**
 * @param {{host: string, port: number, user?: string, pass?: string, secure?: boolean}} opts
 */
export function createTransport(opts) {
  return {
    async send({ from, fromName, to, replyTo, subject, html, text }) {
      let nodemailer;
      try {
        nodemailer = (await import('nodemailer')).default;
      } catch {
        return {
          ok: false,
          error: 'email.provider is "smtp" but nodemailer is not installed — run: npm install nodemailer',
        };
      }

      if (!opts.host) return { ok: false, error: 'SMTP_HOST (or email.host) is not set' };

      const transport = nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        // Port 465 is implicit TLS; 587 negotiates STARTTLS, which nodemailer
        // does automatically when `secure` is false.
        secure: opts.secure ?? opts.port === 465,
        auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      });

      try {
        const info = await transport.sendMail({
          from: { name: fromName, address: from },
          to,
          replyTo,
          subject,
          text,
          html,
        });
        return { ok: true, id: info.messageId };
      } catch (err) {
        return { ok: false, error: `SMTP send failed: ${err.message}` };
      } finally {
        transport.close?.();
      }
    },
  };
}
