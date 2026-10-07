import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerInternalAdminLedgerRuntimeKeyRoutes } from '../../src/routes/internal/admin/billing-ledger-runtime-keys.js';

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() },
  domainRole: { findUnique: vi.fn() }, billingLedgerRuntimeKey: { findMany: vi.fn() } }));
const service = vi.hoisted(() => ({ createLedgerRuntimeKey: vi.fn(), revokeLedgerRuntimeKey: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => db }));
vi.mock('../../src/services/billing-ledger-runtime-key.service.js', () => service);
const adminSecret = 'synthetic-admin-secret-with-enough-length';
const issuer = 'test-uoa'; const domain = 'admin.example.com';
const body = { product: 'nessie', source_domain: 'api.nessie.works',
  ledger_audience: 'https://ledger.unlikeotherai.com' };
async function token(role = 'superuser', tokenDomain = domain, key = adminSecret) {
  return new SignJWT({ email: 'operator@example.test', domain: tokenDomain,
    role, client_id: 'test-admin', tv: 0 }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-admin').setIssuer(issuer).setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(key));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SHARED_SECRET', 'synthetic-product-secret-enough-length');
  vi.stubEnv('AUTH_SERVICE_IDENTIFIER', issuer); vi.stubEnv('ADMIN_AUTH_DOMAIN', domain);
  vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', adminSecret);
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic-only/no-connection');
  db.user.findUnique.mockResolvedValue({ tokenVersion: 0, lifecycleStatus: 'ACTIVE' });
  db.domainRole.findUnique.mockResolvedValue({ role: 'SUPERUSER' });
});
afterEach(() => vi.unstubAllEnvs());
async function call(method: 'GET' | 'POST', credential?: string, payload: object = body,
  suffix = '') {
  const app = Fastify({ logger: false }); registerErrorHandler(app);
  registerInternalAdminLedgerRuntimeKeyRoutes(app);
  try { return await app.inject({ method,
    url: `/internal/admin/billing/ledger-runtime-keys${suffix}`,
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    ...(method === 'POST' ? { payload } : {}),
  }); } finally { await app.close(); }
}
it('all three operations refuse absent, ordinary, wrong-domain and product credentials', async () => {
  for (const credential of [undefined, await token('user'),
    await token('superuser', 'api.nessie.works'), await token('superuser', domain, 'product-secret')]) {
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/key-1/revoke']] as const) {
      const response = await call(method, credential, body, suffix);
      expect([401, 403]).toContain(response.statusCode);
      expect(response.body).not.toContain('operator@example.test');
    }
  }
  expect(service.createLedgerRuntimeKey).not.toHaveBeenCalled();
  expect(service.revokeLedgerRuntimeKey).not.toHaveBeenCalled();
  expect(db.billingLedgerRuntimeKey.findMany).not.toHaveBeenCalled();
});
it('checks the live admin role and credential epoch before issuing or listing', async () => {
  const credential = await token();
  db.domainRole.findUnique.mockResolvedValue({ role: 'USER' });
  expect((await call('POST', credential)).statusCode).toBe(403);
  expect((await call('GET', credential)).statusCode).toBe(403);
  db.domainRole.findUnique.mockResolvedValue({ role: 'SUPERUSER' });
  db.user.findUnique.mockResolvedValue({ tokenVersion: 1, lifecycleStatus: 'ACTIVE' });
  expect((await call('POST', credential)).statusCode).toBe(401);
  expect(service.createLedgerRuntimeKey).not.toHaveBeenCalled();
});
it('returns only nonsecret metadata with no-store; create secret appears once with verified actor', async () => {
  const createdAt = new Date('2026-10-07T12:00:00.000Z');
  const secret = `uoa_ledger_${'a'.repeat(43)}`;
  db.billingLedgerRuntimeKey.findMany.mockResolvedValue([{ id: 'key-1',
    service: { identifier: body.product }, keyPrefix: 'uoa_ledger_fixture',
    ledgerAudience: body.ledger_audience, sourceDomain: body.source_domain,
    createdAt, revokedAt: null, secretDigest: 'digest-only', secret }]);
  const credential = await token();
  const list = await call('GET', credential);
  expect(list.statusCode).toBe(200); expect(list.headers['cache-control']).toBe('no-store');
  expect(list.json().keys[0]).toEqual({ id: 'key-1', ...body, key_prefix: 'uoa_ledger_fixture',
    created_at: createdAt.toISOString(), revoked_at: null });
  expect(list.body).not.toContain(secret); expect(list.body).not.toContain('digest-only');
  service.createLedgerRuntimeKey.mockResolvedValue({ id: 'key-1',
    keyPrefix: 'uoa_ledger_fixture', createdAt, secret });
  const create = await call('POST', credential);
  expect(create.json().secret).toBe(secret); expect(create.headers['cache-control']).toBe('no-store');
  expect(service.createLedgerRuntimeKey).toHaveBeenCalledWith({ product: body.product,
    sourceDomain: body.source_domain, ledgerAudience: body.ledger_audience,
    actorEmail: 'operator@example.test' });
  service.revokeLedgerRuntimeKey.mockResolvedValue({ id: 'key-1', revokedAt: createdAt });
  const revoke = await call('POST', credential, {}, '/key-1/revoke');
  expect(revoke.headers['cache-control']).toBe('no-store');
  expect(service.revokeLedgerRuntimeKey).toHaveBeenCalledWith('key-1', 'operator@example.test');
});
it('refuses caller-provided actor/unknown fields before service writes', async () => {
  const response = await call('POST', await token(), { ...body, actorEmail: 'other@example.test' });
  expect(response.statusCode).toBe(400); expect(service.createLedgerRuntimeKey).not.toHaveBeenCalled();
});
