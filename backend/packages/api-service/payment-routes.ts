import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { paymentsService, PaymentError, verifyRazorpayWebhook, verifyStripeWebhook, type Currency } from '../shared/payments/index.js';
import { userAccountService } from './user-account.service.js';
import { requireUser } from './auth-routes.js';
import { createLogger } from '../shared/logger/index.js';

// ============================================================
// PAYMENTS API — credit packs (Razorpay for INR, Stripe for USD) and the
// two provider webhooks. Webhooks are checked against the raw body, so they
// live in their own scope with a raw JSON parser.
// ============================================================

const logger = createLogger('payment-routes');
type Authed = FastifyRequest & { userId: string };
const uid = (req: FastifyRequest) => (req as Authed).userId;
const currencyOf = (v: unknown): Currency => (String(v ?? '').toUpperCase() === 'USD' ? 'USD' : 'INR');

export function registerPaymentRoutes(app: FastifyInstance, apiKeyAuth: preHandlerHookHandler): void {
  const auth = { preHandler: [apiKeyAuth, requireUser as preHandlerHookHandler] };
  const fail = (err: unknown) => {
    if (err instanceof PaymentError) return { status: err.statusCode, body: { error: err.message } };
    throw err;
  };

  app.get('/me/payments/packs', auth, async (req) => paymentsService.catalog(currencyOf((req.query as { currency?: string }).currency)));

  app.post('/me/payments/checkout', auth, async (req, reply) => {
    const { packId, currency } = (req.body ?? {}) as { packId?: string; currency?: string };
    if (!packId) return reply.status(400).send({ error: 'packId is required' });
    try {
      const user = await userAccountService.findById(uid(req));
      return await paymentsService.checkout(uid(req), packId, currencyOf(currency), user?.email);
    } catch (err) {
      const f = fail(err);
      return reply.status(f.status).send(f.body);
    }
  });

  // Razorpay Checkout's handler hands these three back to the page.
  app.post('/me/payments/razorpay/confirm', auth, async (req, reply) => {
    const b = (req.body ?? {}) as { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string };
    if (!b.razorpay_order_id || !b.razorpay_payment_id || !b.razorpay_signature) {
      return reply.status(400).send({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
    }
    try {
      const r = await paymentsService.confirmRazorpay(uid(req), b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
      return { ok: true, granted: r?.granted ?? false };
    } catch (err) {
      const f = fail(err);
      return reply.status(f.status).send(f.body);
    }
  });

  app.get('/me/payments', auth, async (req) => ({ payments: await paymentsService.history(uid(req)) }));

  // ── Webhooks (no user, no API key: the provider's signature is the auth) ──
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(Object.assign(err as Error, { statusCode: 400 }), undefined);
      }
    });
    const raw = (req: FastifyRequest) => (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';

    scope.post('/webhooks/razorpay', async (req, reply) => {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const sig = String(req.headers['x-razorpay-signature'] ?? '');
      if (!secret || !sig || !verifyRazorpayWebhook(raw(req), sig, secret)) return reply.status(401).send({ error: 'Bad signature' });
      const r = await paymentsService.handleRazorpayEvent(req.body as Parameters<typeof paymentsService.handleRazorpayEvent>[0]);
      logger.info('webhook:razorpay', { event: (req.body as { event?: string }).event, granted: r?.granted ?? null });
      return { ok: true };
    });

    scope.post('/webhooks/stripe', async (req, reply) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      const sig = String(req.headers['stripe-signature'] ?? '');
      if (!secret || !sig || !verifyStripeWebhook(raw(req), sig, secret)) return reply.status(401).send({ error: 'Bad signature' });
      const r = await paymentsService.handleStripeEvent(req.body as Parameters<typeof paymentsService.handleStripeEvent>[0]);
      logger.info('webhook:stripe', { type: (req.body as { type?: string }).type, granted: r?.granted ?? null });
      return { ok: true };
    });
  });
}
