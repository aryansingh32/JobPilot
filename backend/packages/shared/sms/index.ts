import { createLogger } from '../logger/index.js';

// ============================================================
// SMS — pluggable sender via Twilio's REST API (plain fetch, no
// SDK dependency). Falls back to a console log in dev when no
// provider credentials are configured, so the auth flow is fully
// testable without a real SMS account.
// ============================================================

const logger = createLogger('shared-sms');

export async function sendSms(to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    logger.warn('sms:dev-fallback-console', { to });
    // eslint-disable-next-line no-console
    console.log(`[DEV SMS] To: ${to}\n${body}`);
    return;
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('sms:send-failed', { status: res.status, body: text });
    throw new Error(`SMS send failed: ${res.status}`);
  }
}

export async function sendOtpSms(to: string, code: string): Promise<void> {
  await sendSms(to, `Your verification code is ${code}. It expires in 5 minutes.`);
}
