import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { BillingAppKeyPurpose } from '@prisma/client';
import { registerModelPriceRoutes } from '../../src/routes/billing/model-prices.js';
import { verifyBillingAppKey } from '../../src/services/billing-app-key.service.js';
import { getModelDisplayPrices } from '../../src/services/billing-model-prices.service.js';
import { AppError } from '../../src/utils/errors.js';

vi.mock('../../src/services/billing-app-key.service.js', () => ({ verifyBillingAppKey: vi.fn() }));
vi.mock('../../src/services/billing-model-prices.service.js', () => ({ getModelDisplayPrices: vi.fn() }));
const request = { product: 'nessie', organisation_id: 'org', team_id: 'team', user_id: 'user',
  models: [{ provider: 'provider', model: 'model', pricing: null }] };
const response = { ...request, models: [{ provider: 'provider', model: 'model', status: 'unavailable',
  reason: 'missing', input: null, output: null, cached_input: null, updated_at: null, dimensions: [] }],
currency: 'credits', basis: 'per_million_tokens', advisory: true, payment_collection_enabled: false,
issued_at: '2026-10-22T12:00:00.000Z', expires_at: '2026-10-22T12:05:00.000Z' };

beforeEach(() => vi.resetAllMocks());

it('requires a lifecycle key and actor, validates the body and returns no-store customer rates', async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof AppError ? error.statusCode : 400).send({ error: error.message });
  });
  registerModelPriceRoutes(app);
  try {
    const inject = (headers: Record<string, string>, payload: unknown = request) => app.inject({
      method: 'POST', url: '/billing/v1/model-prices', headers, payload: payload as never,
    });
    expect((await inject({})).statusCode).toBe(401);
    vi.mocked(verifyBillingAppKey).mockResolvedValue({ purpose: BillingAppKeyPurpose.ENTITLEMENT } as never);
    expect((await inject({ 'x-uoa-app-key': 'uoa_app_test' })).statusCode).toBe(403);
    vi.mocked(verifyBillingAppKey).mockResolvedValue({ purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE } as never);
    expect((await inject({ 'x-uoa-app-key': 'uoa_app_test' })).statusCode).toBe(401);
    const headers = { 'x-uoa-app-key': 'uoa_app_test', 'x-uoa-actor': 'signed-actor' };
    expect((await inject(headers, { ...request, models: [] })).statusCode).toBe(400);
    expect(getModelDisplayPrices).not.toHaveBeenCalled();
    vi.mocked(getModelDisplayPrices).mockResolvedValue(response as never);
    const result = await inject(headers);
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.json()).toEqual(response);
    expect(getModelDisplayPrices).toHaveBeenCalledWith(expect.objectContaining({ request, actorToken: 'signed-actor' }));
  } finally { await app.close(); }
});
