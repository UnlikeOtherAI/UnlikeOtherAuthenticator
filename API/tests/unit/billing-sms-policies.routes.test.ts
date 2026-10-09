import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerInternalAdminSmsPolicyRoutes } from '../../src/routes/internal/admin/billing-sms-policies.js';

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, domainRole: { findUnique: vi.fn() } }));
const service = vi.hoisted(() => ({ previewSmsFxPolicy: vi.fn(), previewSmsRoutePolicy: vi.fn(),
  acceptSmsFxPolicy: vi.fn(), acceptSmsRoutePolicy: vi.fn(), listSmsPolicies: vi.fn(),
  serializeSmsFxPolicy: vi.fn((value) => value), serializeSmsRoutePolicy: vi.fn((value) => value) }));
const recovery = vi.hoisted(() => ({ listSmsRecoveryResources: vi.fn(), readSmsRecoveryResource: vi.fn() }));
const refunds = vi.hoisted(() => ({ verifySmsNumberRefund: vi.fn() }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => db }));
vi.mock('../../src/services/billing-sms-policy-admin.service.js', async (original) => ({
  ...await original<object>(), ...service,
}));
vi.mock('../../src/services/billing-sms-recovery-admin.service.js', () => recovery);
vi.mock('../../src/services/billing-sms-refund-recovery.service.js', async (original) => ({
  ...await original<object>(), ...refunds,
}));
const secret = 'synthetic-admin-secret-with-enough-length'; const domain = 'admin.example.com';
async function token(role = 'superuser', tokenDomain = domain, key = secret) {
  return new SignJWT({ email: 'operator@example.test', domain: tokenDomain, role, client_id: 'admin', tv: 0 })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('admin-1').setIssuer('test-uoa')
    .setAudience(ACCESS_TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(key));
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('SHARED_SECRET', 'synthetic-product-secret-enough-length');
  vi.stubEnv('AUTH_SERVICE_IDENTIFIER', 'test-uoa'); vi.stubEnv('ADMIN_AUTH_DOMAIN', domain);
  vi.stubEnv('ADMIN_ACCESS_TOKEN_SECRET', secret); vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/no-connection');
  db.user.findUnique.mockResolvedValue({ tokenVersion: 0, lifecycleStatus: 'ACTIVE' });
  db.domainRole.findUnique.mockResolvedValue({ role: 'SUPERUSER' });
});
afterEach(() => vi.unstubAllEnvs());
async function call(path: string, method: 'GET' | 'POST', credential?: string, payload: object = {}) {
  const app = Fastify({ logger: false }); registerErrorHandler(app); registerInternalAdminSmsPolicyRoutes(app);
  try { return await app.inject({ url: `/internal/admin/billing/sms-policies${path}`, method,
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    ...(method === 'POST' ? { payload } : {}) }); } finally { await app.close(); }
}
it('guards every private evidence and recovery route against absent/ordinary/product/wrong-domain credentials', async () => {
  for (const credential of [undefined, await token('user'), await token('superuser', 'api.nessie.works'), await token('superuser', domain, 'product-secret')]) {
    for (const [path, method] of [['', 'GET'], ['/fx/preview', 'POST'], ['/fx/accept', 'POST'],
      ['/routes/preview', 'POST'], ['/routes/accept', 'POST'], ['/recovery', 'GET'], ['/recovery/resource-1', 'GET'],
      ['/liabilities?kind=inbound', 'GET'], ['/recovery/resource-1/verify-refund', 'POST']] as const) {
      expect([401, 403]).toContain((await call(path, method, credential)).statusCode);
    }
  }
  expect(service.previewSmsFxPolicy).not.toHaveBeenCalled(); expect(service.listSmsPolicies).not.toHaveBeenCalled();
  expect(recovery.readSmsRecoveryResource).not.toHaveBeenCalled();
  expect(refunds.verifySmsNumberRefund).not.toHaveBeenCalled();
});
it('requires explicit existing refund verification with unique refund IDs and propagates verified operator only', async () => {
  const credential = await token(); const value = { subscription_id: 'sub-local', refund_ids: ['re_fixture'],
    reason: 'Verify original paid number refund evidence.', verify_existing_refunds: true };
  for (const change of [{ verify_existing_refunds: false }, { refund_ids: ['re_fixture', 're_fixture'] },
    { refund_ids: [] }, { accepted_by_user_id: 'other' }]) {
    expect((await call('/recovery/resource-1/verify-refund', 'POST', credential, { ...value, ...change })).statusCode).toBe(400);
  }
  expect(refunds.verifySmsNumberRefund).not.toHaveBeenCalled();
  refunds.verifySmsNumberRefund.mockResolvedValue({ resource_id: 'resource-1', state: 'ended' });
  const result = await call('/recovery/resource-1/verify-refund', 'POST', credential, value);
  expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('private, no-store');
  expect(refunds.verifySmsNumberRefund).toHaveBeenCalledWith('resource-1', value, {
    userId: 'admin-1', tokenVersion: 0, email: 'operator@example.test', domain,
  });
});
it('requires explicit acceptance of both route dimensions and rejects caller-supplied acceptance provenance', async () => {
  const credential = await token(); const acceptance = { preview_token: 'signed-preview',
    acceptance_reason: 'Verified source-supported route fee bounds.', policy_understood: true,
    complete_segment_bound: true, complete_message_bound: true };
  for (const change of [{ complete_segment_bound: false }, { complete_message_bound: undefined },
    { accepted_by_user_id: 'other' }, { evidence_digest: 'x' }]) {
    expect((await call('/routes/accept', 'POST', credential, { ...acceptance, ...change })).statusCode).toBe(400);
  }
  expect(service.acceptSmsRoutePolicy).not.toHaveBeenCalled();
  service.acceptSmsRoutePolicy.mockResolvedValue({ id: 'policy-1' });
  const result = await call('/routes/accept', 'POST', credential, acceptance);
  expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('private, no-store');
  expect(service.acceptSmsRoutePolicy).toHaveBeenCalledWith({ userId: 'admin-1', tokenVersion: 0,
    email: 'operator@example.test', domain }, 'signed-preview', acceptance.acceptance_reason);
});
it('uses the fixed refresh service with verified actor and refuses current revoked role/epoch', async () => {
  const credential = await token(); service.previewSmsFxPolicy.mockResolvedValue({ evidence: { rate_date: '2026-10-08' } });
  const preview = await call('/fx/preview', 'POST', credential);
  expect(preview.statusCode).toBe(200); expect(preview.headers['cache-control']).toBe('private, no-store');
  db.domainRole.findUnique.mockResolvedValue({ role: 'USER' });
  expect((await call('', 'GET', credential)).statusCode).toBe(403);
  db.domainRole.findUnique.mockResolvedValue({ role: 'SUPERUSER' });
  db.user.findUnique.mockResolvedValue({ tokenVersion: 1, lifecycleStatus: 'ACTIVE' });
  expect((await call('/fx/accept', 'POST', credential)).statusCode).toBe(401);
});
