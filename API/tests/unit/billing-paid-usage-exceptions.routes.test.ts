import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const writeOff = vi.hoisted(() => vi.fn());
vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (request: { adminAccessTokenClaims?: unknown }) => {
    request.adminAccessTokenClaims = {
      userId: 'operator', tokenVersion: 0, email: 'operator@example.com',
    };
  },
}));
vi.mock('../../src/config/env.js', () => ({
  getEnv: () => ({}), getAdminAuthDomain: () => 'authentication.unlikeotherai.com',
}));
vi.mock('../../src/services/billing-paid-usage-exception.service.js', () => ({
  listPaidUsageExceptions: vi.fn().mockResolvedValue({ exceptions: [], has_more: false }),
  writeOffPaidUsageException: writeOff,
}));

import { registerInternalAdminPaidUsageExceptionRoutes } from
  '../../src/routes/internal/admin/billing-paid-usage-exceptions.js';

const secret = new TextEncoder().encode('route-fixture-secret-long-enough');
async function token(issuedAt: number) {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3_600).sign(secret);
}

describe('private paid usage exception route', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('requires recent operator authority before invoking a write-off', async () => {
    const app = Fastify();
    registerInternalAdminPaidUsageExceptionRoutes(app);
    const now = Math.floor(Date.now() / 1_000);
    const payload = { evidence_digest: 'a'.repeat(64),
      idempotency_key: 'b'.repeat(64), reason: 'Verified provider overage' };
    const old = await app.inject({ method: 'POST',
      url: '/internal/admin/billing/paid-usage-exceptions/dispatch-1/write-off',
      headers: { authorization: `Bearer ${await token(now - 600)}` },
      payload });
    expect(old.statusCode).toBe(401);
    expect(writeOff).not.toHaveBeenCalled();
    writeOff.mockResolvedValue({ dispatch_id: 'dispatch-1', receipt_id: 'receipt-1',
      status: 'WRITTEN_OFF', evidence_digest: payload.evidence_digest,
      gross_rated_microcredits: '4', collectible_microcredits: '1',
      waived_microcredits: '3' });
    const fresh = await app.inject({ method: 'POST',
      url: '/internal/admin/billing/paid-usage-exceptions/dispatch-1/write-off',
      headers: { authorization: `Bearer ${await token(now)}` }, payload });
    expect(fresh.statusCode).toBe(200);
    expect(writeOff).toHaveBeenCalledWith(expect.objectContaining({
      dispatchId: 'dispatch-1', actorUserId: 'operator',
      evidenceDigest: payload.evidence_digest,
    }));
    await app.close();
  });
});
