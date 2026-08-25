import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '../logger/index.js';

// ============================================================
// EMAIL — pluggable sender. Uses SMTP if configured; otherwise
// logs the message to the console so the auth flow is fully
// testable in dev without real provider credentials.
// ============================================================

const logger = createLogger('shared-email');

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;

  const host = process.env.SMTP_HOST;
  if (!host) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return transporter;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    logger.warn('email:dev-fallback-console', { to, subject });
    // eslint-disable-next-line no-console
    console.log(`[DEV EMAIL] To: ${to} | Subject: ${subject}\n${text}`);
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM ?? 'no-reply@jobpilot.app',
    to,
    subject,
    text,
  });
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  await sendEmail(to, 'Your verification code', `Your verification code is ${code}. It expires in 5 minutes.`);
}
