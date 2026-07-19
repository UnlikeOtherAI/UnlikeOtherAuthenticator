import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

const webhookService = vi.hoisted(() => ({
  handleStripeWebhook: vi.fn(),
}));

vi.mock('../../src/services/billing-stripe-webhook.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/billing-stripe-webhook.service.js')
  >('../../src/services/billing-stripe-webhook.service.js');
  return { ...actual, ...webhookService };
});

const originalSharedSecret = process.env.SHARED_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
  Reflect.deleteProperty(process.env, 'DATABASE_URL');
});

afterAll(() => {
  if (originalSharedSecret === undefined) Reflect.deleteProperty(process.env, 'SHARED_SECRET');
  else process.env.SHARED_SECRET = originalSharedSecret;
  if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  webhookService.handleStripeWebhook.mockResolvedValue({ duplicate: false });
});

describe('Stripe webhook route', () => {
  it('passes the exact unmodified body and dedicated Stripe signature to verification', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const raw = '{ "id": "evt_1", "data": { "object": {} } }\n';
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/webhook',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 't=123,v1=signature',
        },
        payload: raw,
      });

      expect(response.statusCode).toBe(200);
      expect(webhookService.handleStripeWebhook).toHaveBeenCalledTimes(1);
      const input = webhookService.handleStripeWebhook.mock.calls[0]?.[0];
      expect(Buffer.isBuffer(input.rawBody)).toBe(true);
      expect(input.rawBody.equals(Buffer.from(raw))).toBe(true);
      expect(input.signature).toBe('t=123,v1=signature');
    } finally {
      await app.close();
    }
  });

  it('rejects a missing signature header before processing', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/billing/v1/stripe/webhook',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(400);
      expect(webhookService.handleStripeWebhook).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('Stripe usage export route', () => {
  it('is platform-superuser-only', async () => {
    const app = await createApp();
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/admin/billing/stripe/usage-exports',
        payload: {
          subscription_id: 'subscription_1',
          billing_month: '2026-07',
        },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
