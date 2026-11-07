import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const environment = vi.hoisted(() => ({ STRIPE_BILLING_ENABLED: true,
  STRIPE_SECRET_KEY: 'rk_test_expired', STRIPE_WEBHOOK_SECRET: 'whsec_legacy',
  STRIPE_LIVE_SECRET_KEY: 'rk_live_current', STRIPE_LIVE_WEBHOOK_SECRET: 'whsec_live',
  STRIPE_LIVE_ACCOUNT_ID: 'acct_main', STRIPE_SANDBOX_SECRET_KEY: 'rk_test_current',
  STRIPE_SANDBOX_WEBHOOK_SECRET: 'whsec_sandbox', STRIPE_SANDBOX_ACCOUNT_ID: 'acct_main' }));
vi.mock('../../src/config/env.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/config/env.js')>(), getEnv: () => environment,
}));
import { requireStripeBillingEnabled, stripeRuntimeForAccount, resolveStripeAccountContext,
  resetStripeClientCache, verifyStripeWebhookRuntime, STRIPE_BILLING_API_VERSION }
  from '../../src/services/billing-stripe-client.service.js';

describe('explicit Stripe billing bindings', () => {
  afterEach(() => { vi.restoreAllMocks(); resetStripeClientCache(); });

  it('defaults new work to live and never falls back to a legacy test key', () => {
    expect(requireStripeBillingEnabled().livemode).toBe(true);
    const saved = environment.STRIPE_LIVE_SECRET_KEY;
    environment.STRIPE_LIVE_SECRET_KEY = '';
    expect(() => requireStripeBillingEnabled()).toThrow('BILLING_STRIPE_MODE_NOT_CONFIGURED');
    environment.STRIPE_LIVE_SECRET_KEY = saved;
  });

  it('uses the new sandbox binding for captured main TEST history', () => {
    const historical = { id: 'test', stripeAccountId: 'acct_main', livemode: false };
    const selected = stripeRuntimeForAccount(historical);
    expect(selected.client).toBe(requireStripeBillingEnabled('sandbox').client);
    expect(selected.client).not.toBe(requireStripeBillingEnabled('live').client);
    expect(selected.webhookSecret).toBe('whsec_sandbox');
  });

  it('verifies account identity before upserting a projection', async () => {
    const runtime = requireStripeBillingEnabled('sandbox');
    vi.spyOn(runtime.client.accounts, 'retrieveCurrent').mockResolvedValue({ id: 'acct_other' } as never);
    const upsert = vi.fn();
    await expect(resolveStripeAccountContext(runtime.client, false,
      { billingStripeAccount: { upsert } } as never)).rejects.toThrow('BILLING_STRIPE_ACCOUNT_MISMATCH');
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([true, false])('routes signed mode %s without reading Stripe first', (livemode) => {
    const body = JSON.stringify({ id: 'evt_mode', object: 'event', livemode,
      api_version: STRIPE_BILLING_API_VERSION, type: 'checkout.session.expired',
      data: { object: { id: 'cs_1' } } });
    const secret = livemode ? 'whsec_live' : 'whsec_sandbox';
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    const verified = verifyStripeWebhookRuntime(Buffer.from(body), signature);
    expect(verified.livemode).toBe(livemode);
    expect(verified.webhookSecret).toBe(secret);
    expect(verified.event.id).toBe('evt_mode');
  });

  it('refuses an event signed for the opposite mode', () => {
    const payload = JSON.stringify({ id: 'evt_wrong', livemode: true });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_sandbox' });
    expect(() => verifyStripeWebhookRuntime(Buffer.from(payload), signature))
      .toThrow('INVALID_STRIPE_WEBHOOK_SIGNATURE');
  });
  it('deduplicates the reused historical endpoint secret and prefers the new sandbox key', () => {
    const original = environment.STRIPE_SANDBOX_WEBHOOK_SECRET;
    environment.STRIPE_SANDBOX_WEBHOOK_SECRET = environment.STRIPE_WEBHOOK_SECRET;
    try {
      const payload = JSON.stringify({ id: 'evt_historical', livemode: false });
      const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: environment.STRIPE_WEBHOOK_SECRET });
      const verified = verifyStripeWebhookRuntime(Buffer.from(payload), signature);
      expect(verified.client).toBe(requireStripeBillingEnabled('sandbox').client);
    } finally { environment.STRIPE_SANDBOX_WEBHOOK_SECRET = original; }
  });
});
