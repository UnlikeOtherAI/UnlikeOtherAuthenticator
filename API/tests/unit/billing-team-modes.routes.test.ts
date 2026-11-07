import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { registerInternalAdminBillingTeamModeRoutes } from '../../src/routes/internal/admin/billing-team-modes.js';
const service = vi.hoisted(() => ({ readTeamBillingMode: vi.fn(), setTeamBillingMode: vi.fn() }));
vi.mock('../../src/services/billing-team-mode.service.js', () => service);
const secret = 'mode-admin-test-secret-of-sufficient-length';
const path = '/internal/admin/billing/organisations/org_1/teams/team_1/mode';
async function token(role = 'superuser', domain = 'admin.example.test') {
  return new SignJWT({ email: 'admin@example.test', role, domain, tv: 7, client_id: `admin:${domain}` })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('admin_1').setIssuer('uoa-auth-service')
    .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
}
async function app() {
  vi.stubEnv('SHARED_SECRET', secret); vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', secret);
  vi.stubEnv('ADMIN_AUTH_DOMAIN', 'admin.example.test'); vi.stubEnv('DATABASE_URL', undefined);
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => reply.code(
    error.name === 'ZodError' ? 400 : error.statusCode ?? 500).send({ error: error.message }));
  registerInternalAdminBillingTeamModeRoutes(server);
  return server;
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('platform-owned team mode routes', () => {
  it('refuses missing tokens, regular product members and another domain’s superuser', async () => {
    const server = await app();
    try {
      for (const method of ['GET', 'PUT'] as const) {
        for (const [credential, status] of [[null, 401], [await token('user'), 403],
          [await token('superuser', 'product.example.test'), 403]] as const) {
          const response = await server.inject({ method, url: path,
            headers: credential ? { authorization: `Bearer ${credential}` } : {},
            ...(method === 'PUT' ? { payload: { mode: 'sandbox', expected_revision: 0 } } : {}) });
          expect(response.statusCode, response.body).toBe(status);
        }
      }
      expect(service.readTeamBillingMode).not.toHaveBeenCalled();
      expect(service.setTeamBillingMode).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it('passes exact team, operator and epoch and refuses browser-supplied extra authority', async () => {
    const server = await app(); const authorization = `Bearer ${await token()}`;
    service.readTeamBillingMode.mockResolvedValue({ mode: 'live', revision: 0, blockers: [] });
    service.setTeamBillingMode.mockResolvedValue({ mode: 'sandbox', revision: 1, blockers: [] });
    try {
      const read = await server.inject({ method: 'GET', url: path, headers: { authorization } });
      expect(read.statusCode, read.body).toBe(200); expect(read.headers['cache-control']).toBe('private, no-store');
      expect(service.readTeamBillingMode).toHaveBeenCalledWith({ organisationId: 'org_1', teamId: 'team_1' });
      for (const payload of [{ mode: 'sandbox' }, { mode: 'test', expected_revision: 0 },
        { mode: 'sandbox', expected_revision: -1 }, { mode: 'sandbox', expected_revision: 0, actor: 'root' }]) {
        expect((await server.inject({ method: 'PUT', url: path, headers: { authorization }, payload })).statusCode).toBe(400);
      }
      expect(service.setTeamBillingMode).not.toHaveBeenCalled();
      const saved = await server.inject({ method: 'PUT', url: path, headers: { authorization },
        payload: { mode: 'sandbox', expected_revision: 0 } });
      expect(saved.statusCode).toBe(200);
      expect(service.setTeamBillingMode).toHaveBeenCalledWith({ organisationId: 'org_1', teamId: 'team_1',
        mode: 'sandbox', expectedRevision: 0, actor: { userId: 'admin_1', email: 'admin@example.test',
          tokenVersion: 7, domain: 'admin.example.test' } });
    } finally { await server.close(); }
  });
});
