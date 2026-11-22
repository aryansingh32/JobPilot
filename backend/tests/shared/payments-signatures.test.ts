import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyRazorpayPayment, verifyRazorpayWebhook, verifyStripeWebhook } from '../../packages/shared/payments/index.js';

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

describe('Razorpay', () => {
  it('checkout callback: HMAC(order|payment) with the key secret', () => {
    const sig = hmac('key_secret', 'order_ABC|pay_XYZ');
    expect(verifyRazorpayPayment('order_ABC', 'pay_XYZ', sig, 'key_secret')).toBe(true);
    expect(verifyRazorpayPayment('order_ABC', 'pay_OTHER', sig, 'key_secret')).toBe(false);
    expect(verifyRazorpayPayment('order_ABC', 'pay_XYZ', sig, 'wrong_secret')).toBe(false);
    expect(verifyRazorpayPayment('order_ABC', 'pay_XYZ', 'short', 'key_secret')).toBe(false);
  });
  it('webhook: HMAC of the exact raw body', () => {
    const body = '{"event":"payment.captured","payload":{}}';
    expect(verifyRazorpayWebhook(body, hmac('whsec', body), 'whsec')).toBe(true);
    expect(verifyRazorpayWebhook(body.replace('captured', 'failed'), hmac('whsec', body), 'whsec')).toBe(false);
  });
});

describe('Stripe', () => {
  const body = '{"type":"checkout.session.completed"}';
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);
  it('accepts a fresh, correctly signed event', () => {
    expect(verifyStripeWebhook(body, `t=${t},v1=${hmac('whsec_x', `${t}.${body}`)}`, 'whsec_x', 300, now)).toBe(true);
  });
  it('accepts any matching v1 (secret rotation)', () => {
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${hmac('whsec_x', `${t}.${body}`)}`;
    expect(verifyStripeWebhook(body, header, 'whsec_x', 300, now)).toBe(true);
  });
  it('rejects tampered bodies, wrong secrets and replays', () => {
    const sig = hmac('whsec_x', `${t}.${body}`);
    expect(verifyStripeWebhook(`${body} `, `t=${t},v1=${sig}`, 'whsec_x', 300, now)).toBe(false);
    expect(verifyStripeWebhook(body, `t=${t},v1=${sig}`, 'whsec_other', 300, now)).toBe(false);
    expect(verifyStripeWebhook(body, `t=${t},v1=${sig}`, 'whsec_x', 300, now + 10 * 60_000)).toBe(false);
    expect(verifyStripeWebhook(body, `v1=${sig}`, 'whsec_x', 300, now)).toBe(false);
  });
});
