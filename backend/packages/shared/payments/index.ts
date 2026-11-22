import { createHmac, timingSafeEqual } from 'crypto';
import { getPgPool } from '../db/index.js';
import { getBool, getSetting } from '../config/settings.js';
import { creditsService } from '../credits/index.js';
import { notificationsService } from '../notifications/index.js';
import { createLogger } from '../logger/index.js';

// ============================================================
// PAYMENTS — credit packs. INR goes through Razorpay (order + Checkout.js),
// USD through Stripe (hosted Checkout). A payment row is created first; the
// credits are granted once the provider confirms it — the browser callback
// (Razorpay signature) or the webhook, whichever arrives first. Every
// confirmation is signature-checked; a second one changes nothing.
//
// Keys (env): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET; PUBLIC_APP_URL for Stripe's
// return links.
// ============================================================

const logger = createLogger('payments');

export class PaymentError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export type Currency = 'INR' | 'USD';
export type Provider = 'razorpay' | 'stripe';

export interface Pack {
  id: string;
  label: string;
  credits: number;
  prices: Partial<Record<Currency, number>>;
}

const PROVIDER_FOR: Record<Currency, Provider> = { INR: 'razorpay', USD: 'stripe' };

export function providerConfigured(p: Provider): boolean {
  return p === 'razorpay'
    ? !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
    : !!process.env.STRIPE_SECRET_KEY;
}

// ─── Signatures (pure; unit-tested) ──────────────────────────

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Razorpay Checkout callback: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyRazorpayPayment(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}

/** Razorpay webhook: HMAC_SHA256(raw body, webhook secret) in X-Razorpay-Signature. */
export function verifyRazorpayWebhook(rawBody: string, signature: string, secret: string): boolean {
  return safeEqual(createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

/** Stripe webhook: header "t=…,v1=…"; v1 = HMAC_SHA256(`${t}.${rawBody}`, whsec); t within tolerance. */
export function verifyStripeWebhook(rawBody: string, header: string, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return header
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => safeEqual(expected, kv.slice(3)));
}

// ─── Provider calls ──────────────────────────────────────────

async function razorpayOrder(amount: number, currency: Currency, receipt: string, notes: Record<string, string>) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency, receipt, notes }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
  if (!res.ok || !body.id) throw new PaymentError(`Razorpay: ${body.error?.description ?? `HTTP ${res.status}`}`, 502);
  return body.id;
}

async function stripeSession(input: { amount: number; currency: Currency; packLabel: string; credits: number; paymentId: string; email?: string | null }) {
  const app = (process.env.PUBLIC_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(input.amount),
    'line_items[0][price_data][product_data][name]': `jobpilot ${input.packLabel} — ${input.credits} credits`,
    client_reference_id: input.paymentId,
    'metadata[payment_id]': input.paymentId,
    success_url: `${app}/?payment=success`,
    cancel_url: `${app}/?payment=cancelled`,
  });
  if (input.email) form.set('customer_email', input.email);
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !body.id || !body.url) throw new PaymentError(`Stripe: ${body.error?.message ?? `HTTP ${res.status}`}`, 502);
  return { id: body.id, url: body.url };
}

// ─── Service ─────────────────────────────────────────────────

export const paymentsService = {
  async packs(): Promise<Pack[]> {
    const raw = (await getSetting('payments.packs')) as Pack[];
    return Array.isArray(raw) ? raw.filter((p) => p?.id && p.credits > 0 && p.prices) : [];
  },

  /** Packs priced in this currency, and whether paying works right now. */
  async catalog(currency: Currency) {
    const provider = PROVIDER_FOR[currency];
    const enabled = (await getBool('payments.enabled')) && providerConfigured(provider);
    const packs = (await this.packs())
      .filter((p) => p.prices[currency])
      .map((p) => ({ id: p.id, label: p.label, credits: p.credits, amount: p.prices[currency]!, currency }));
    return { enabled, provider, currency, packs };
  },

  /** Start a purchase: a payment row, then the provider's order / checkout session. */
  async checkout(userId: string, packId: string, currency: Currency, email?: string | null) {
    if (!(await getBool('payments.enabled'))) throw new PaymentError('Buying credits is paused right now', 503);
    const provider = PROVIDER_FOR[currency];
    if (!provider) throw new PaymentError('currency must be INR or USD');
    if (!providerConfigured(provider)) throw new PaymentError(`Payments in ${currency} aren't set up yet`, 503);
    const pack = (await this.packs()).find((p) => p.id === packId);
    const amount = pack?.prices[currency];
    if (!pack || !amount) throw new PaymentError('Unknown pack', 404);

    const pool = getPgPool();
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, provider, pack_id, credits, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, provider, pack.id, pack.credits, amount, currency],
    );
    const paymentId = rows[0].id as string;
    try {
      if (provider === 'razorpay') {
        const orderId = await razorpayOrder(amount, currency, paymentId.slice(0, 40), { payment_id: paymentId, user_id: userId });
        await pool.query('UPDATE payments SET provider_ref = $2 WHERE id = $1', [paymentId, orderId]);
        return { provider, paymentId, orderId, keyId: process.env.RAZORPAY_KEY_ID!, amount, currency, credits: pack.credits, label: pack.label };
      }
      const session = await stripeSession({ amount, currency, packLabel: pack.label, credits: pack.credits, paymentId, email });
      await pool.query('UPDATE payments SET provider_ref = $2 WHERE id = $1', [paymentId, session.id]);
      return { provider, paymentId, url: session.url, amount, currency, credits: pack.credits, label: pack.label };
    } catch (err) {
      await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      throw err;
    }
  },

  /**
   * The provider says it's paid: mark it and grant the credits — once.
   * `ref` is the order / session id we stored at checkout.
   */
  async markPaid(provider: Provider, ref: string, providerPayment?: string | null): Promise<{ granted: boolean; paymentId: string } | null> {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `UPDATE payments SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), provider_payment = COALESCE($3, provider_payment)
        WHERE provider = $1 AND provider_ref = $2 AND status IN ('created', 'paid')
        RETURNING id, user_id, credits, pack_id`,
      [provider, ref, providerPayment ?? null],
    );
    const p = rows[0];
    if (!p) return null;
    const granted = await creditsService.purchase(p.user_id, p.id, p.credits, `Bought ${p.credits} credits`);
    if (granted) {
      logger.info('payments:credits-granted', { paymentId: p.id, credits: p.credits, provider });
      await notificationsService.notify(p.user_id, {
        kind: 'announcement',
        title: `${p.credits} credits added`,
        body: 'Thanks for your purchase — they never expire.',
        data: { paymentId: p.id },
      });
    }
    return { granted, paymentId: p.id };
  },

  /** Razorpay Checkout handler response (browser) → verify signature → mark paid. */
  async confirmRazorpay(userId: string, orderId: string, paymentId: string, signature: string) {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw new PaymentError('Razorpay is not set up', 503);
    if (!verifyRazorpayPayment(orderId, paymentId, signature, secret)) throw new PaymentError('Payment could not be verified', 400);
    const { rows } = await getPgPool().query(`SELECT 1 FROM payments WHERE provider = 'razorpay' AND provider_ref = $1 AND user_id = $2`, [orderId, userId]);
    if (!rows.length) throw new PaymentError('Payment not found', 404);
    return this.markPaid('razorpay', orderId, paymentId);
  },

  /** Webhook bodies (already signature-checked by the route). */
  async handleRazorpayEvent(event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } }; order?: { entity?: { id?: string } } } }) {
    if (event.event !== 'payment.captured' && event.event !== 'order.paid') return null;
    const orderId = event.payload?.order?.entity?.id ?? event.payload?.payment?.entity?.order_id;
    return orderId ? this.markPaid('razorpay', orderId, event.payload?.payment?.entity?.id) : null;
  },

  async handleStripeEvent(event: { type?: string; data?: { object?: { id?: string; payment_status?: string; payment_intent?: string } } }) {
    const s = event.data?.object;
    if (!s?.id) return null;
    if ((event.type === 'checkout.session.completed' && s.payment_status === 'paid') || event.type === 'checkout.session.async_payment_succeeded') {
      return this.markPaid('stripe', s.id, s.payment_intent);
    }
    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      await getPgPool().query(`UPDATE payments SET status = 'failed' WHERE provider = 'stripe' AND provider_ref = $1 AND status = 'created'`, [s.id]);
    }
    return null;
  },

  async history(userId: string) {
    const { rows } = await getPgPool().query(
      `SELECT id, provider, pack_id, credits, amount, currency, status, created_at, paid_at
         FROM payments WHERE user_id = $1 AND status <> 'created' ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  },

  /** Admin: recent payments and revenue by currency. */
  async adminList(limit = 100) {
    const pool = getPgPool();
    const [list, totals] = await Promise.all([
      pool.query(
        `SELECT p.*, u.email AS user_email FROM payments p LEFT JOIN users u ON u.id::text = p.user_id
          ORDER BY p.created_at DESC LIMIT $1`,
        [Math.min(limit, 500)],
      ),
      pool.query(
        `SELECT currency, COUNT(*)::int AS paid, SUM(amount)::bigint AS amount, SUM(credits)::int AS credits
           FROM payments WHERE status = 'paid' GROUP BY currency`,
      ),
    ]);
    return {
      payments: list.rows,
      totals: totals.rows,
      providers: { razorpay: providerConfigured('razorpay'), stripe: providerConfigured('stripe') },
    };
  },
};
