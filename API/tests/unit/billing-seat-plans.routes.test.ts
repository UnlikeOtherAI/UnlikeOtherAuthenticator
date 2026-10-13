import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { BILLING_LOCALE_HEADER, BILLING_PRESENTATION_HEADER, BILLING_PRESENTATION_VERSION } from '@unlikeotherai/billing-statement-protocol';
const services = vi.hoisted(() => ({ read: vi.fn(), checkout: vi.fn() }));
vi.mock('../../src/middleware/billing-app-auth.js', () => ({
  requireBillingLifecycleAppKey: async (request: { billingAppKey?: unknown }) => { request.billingAppKey = { id: 'lifecycle' }; },
}));
vi.mock('../../src/services/billing-seat-plans.service.js', () => ({ readSeatPlans: services.read, checkoutSeatPlan: services.checkout }));
import { registerSeatPlanRoutes } from '../../src/routes/billing/seats.js';
const subject = { product: 'nessie', organisation_id: 'company', team_id: 'team', user_id: 'human' };
describe('strict Standard seat customer wire contract', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  async function server() {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : 500).send({ error: 'invalid request' }));
    registerSeatPlanRoutes(app); await app.ready(); return app;
  }
  it('omits plan and funding details for members and forwards exact scope, actor and locale', async () => {
    services.read.mockResolvedValue({ schema_version: 1, product: 'nessie', organisation_id: 'company',
      subject: { team_id: 'team', user_id: 'human' }, can_manage: false });
    const app = await server();
    try {
      const result = await app.inject({ method: 'POST', url: '/billing/v1/seats', payload: subject,
        headers: { 'x-uoa-actor': 'signed-human', [BILLING_PRESENTATION_HEADER]: BILLING_PRESENTATION_VERSION, [BILLING_LOCALE_HEADER]: 'cs' } });
      expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.json()).toEqual({ schema_version: 1, product: 'nessie', organisation_id: 'company',
        subject: { team_id: 'team', user_id: 'human' }, can_manage: false });
      expect(services.read).toHaveBeenCalledWith(expect.objectContaining({ request: subject, actorToken: 'signed-human', locale: 'cs' }));
      expect(services.checkout).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('refuses guessed private tariff selection or missing explicit acceptance before mutation', async () => {
    const app = await server();
    try {
      for (const payload of [{ ...subject, tariff_id: 'private' },
        { ...subject, offer_id: 'offer', terms_version: 'company-standard-seat-v1', accepted: false }]) {
        const result = await app.inject({ method: 'POST', url: '/billing/v1/seats/checkout', payload, headers: { 'x-uoa-actor': 'signed-human' } });
        expect(result.statusCode).toBe(400);
      }
      expect(services.checkout).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('returns the frozen no-store hosted redirect without claiming paid access', async () => {
    const result = { schema_version: 1, product: 'nessie', organisation_id: 'company', checkout_id: 'cs_exact',
      state: 'open', url: 'https://checkout.stripe.com/c/pay/cs_exact', expires_at: new Date(Date.now() + 60_000).toISOString() };
    services.checkout.mockResolvedValue(result);
    const app = await server();
    try {
      const payload = { ...subject, offer_id: 'offer', terms_version: 'company-standard-seat-v1', accepted: true };
      const response = await app.inject({ method: 'POST', url: '/billing/v1/seats/checkout', payload, headers: { 'x-uoa-actor': 'signed-human' } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual(result); expect(services.checkout).toHaveBeenCalledWith(expect.objectContaining({ request: payload }));
    } finally { await app.close(); }
  });
});
