import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/utils/errors.js';
vi.mock('../../src/middleware/config-verifier.js', () => ({ configVerifier: async (request: FastifyRequest) => {
  request.config = { domain: 'api.selkie.live', org_features: { enabled: false } } as NonNullable<FastifyRequest['config']>;
} }));
vi.mock('../../src/middleware/domain-hash-auth.js', () => ({ requireDomainHashAuth: async (request: FastifyRequest) => {
  if (request.headers.authorization !== 'Bearer authorised') throw new AppError('UNAUTHORIZED', 401);
  request.domainAuthClientDomainId = String(request.headers['x-test-domain'] ?? 'legitimate');
} }));
vi.mock('../../src/services/session-broker.service.js', () => ({ validateSessionBroker: vi.fn(async () => ({
  sub: 'subject', expires_at: '2030-01-01T00:00:00.000Z', active: { orgId: 'org', teamId: 'team' },
})) }));
import { registerSessionBrokerRoutes } from '../../src/routes/auth/session-broker.js';
describe('broker ingress and domain rate limits', () => {
  it('allows more than ten legitimate validations and bounds authenticated malformed attempts', async () => {
    const app = Fastify(); registerSessionBrokerRoutes(app);
    try {
      for (let index = 0; index < 20; index++) {
        const response = await app.inject({ method: 'POST', url: '/auth/session-broker/validate', remoteAddress: '192.0.2.1',
          headers: { authorization: 'Bearer authorised' }, payload: { token: 'proof' } });
        expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      }
      const override = await app.inject({ method: 'POST', url: '/auth/session-broker/validate', remoteAddress: '192.0.2.1',
        headers: { authorization: 'Bearer authorised' }, payload: { token: 'proof', org_features: { enabled: true } } });
      expect(override.statusCode).toBeGreaterThanOrEqual(400);
      for (let index = 0; index < 600; index++) await app.inject({ method: 'POST', url: '/auth/session-broker/validate',
        remoteAddress: '192.0.2.2', headers: { authorization: 'Bearer authorised', 'x-test-domain': 'malformed' }, payload: {} });
      expect((await app.inject({ method: 'POST', url: '/auth/session-broker/validate', remoteAddress: '192.0.2.2',
        headers: { authorization: 'Bearer authorised', 'x-test-domain': 'malformed' }, payload: {} })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('bounds unauthenticated ingress before capability validation', async () => {
    const app = Fastify(); registerSessionBrokerRoutes(app);
    try {
      for (let index = 0; index < 1200; index++) {
        const response = await app.inject({ method: 'POST', url: '/auth/session-broker/validate', remoteAddress: '192.0.2.3', payload: { token: 'proof' } });
        expect(response.statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/auth/session-broker/validate', remoteAddress: '192.0.2.3', payload: { token: 'proof' } })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
});
