import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ grant: vi.fn(), read: vi.fn() }));
const superuser = vi.hoisted(() => ({ allow: true }));
vi.mock('../../src/middleware/admin-superuser.js', () => ({
  requireAdminSuperuser: async (request: { adminAccessTokenClaims?: unknown }) => {
    if (!superuser.allow) {
      const { AppError } = await import('../../src/utils/errors.js');
      throw new AppError('FORBIDDEN', 403, 'NOT_SUPERUSER');
    }
    request.adminAccessTokenClaims = {
      userId: 'operator', tokenVersion: 3, email: 'operator@example.com',
      domain: 'authentication.unlikeotherai.com',
    };
  },
}));
vi.mock('../../src/services/billing-credit-admin-grant.service.js', () => ({
  ADMIN_CREDIT_GRANT_REASON_MIN: 12, ADMIN_CREDIT_GRANT_REASON_MAX: 500,
  grantOrganisationCredits: service.grant, readOrganisationCreditGrants: service.read,
}));

import { registerInternalAdminBillingCreditGrantRoutes } from
  '../../src/routes/internal/admin/billing-credit-grants.js';
import { AppError } from '../../src/utils/errors.js';

const secret = new TextEncoder().encode('route-fixture-secret-long-enough');
async function token(issuedAt: number) {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3_600).sign(secret);
}

async function app() {
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.message });
    return reply.code(400).send({ code: 'INVALID' });
  });
  registerInternalAdminBillingCreditGrantRoutes(server);
  return server;
}

const url = '/internal/admin/billing/organisations/org-1/credit-grants';
const payload = { credits: '10000', reason: 'Launch allowance for our team', idempotency_key: 'b'.repeat(64) };
const result = { grant: { id: 'g1' }, replayed: false, balance_after: { microcredits: '10000000000' } };

describe('platform credit grant routes', () => {
  afterEach(() => { vi.clearAllMocks(); superuser.allow = true; });

  it('reads the wallet and grants without a store-cached response', async () => {
    const server = await app();
    service.read.mockResolvedValue({ grants: [] });
    const read = await server.inject({ method: 'GET', url });
    expect(read.statusCode).toBe(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(service.read).toHaveBeenCalledWith('org-1');
    await server.close();
  });

  it('refuses a non-superuser before any service call', async () => {
    superuser.allow = false;
    const server = await app();
    const now = Math.floor(Date.now() / 1_000);
    const response = await server.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${await token(now)}` }, payload });
    expect(response.statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(service.grant).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
    await server.close();
  });

  it('requires a session issued in the last five minutes before granting', async () => {
    const server = await app();
    const now = Math.floor(Date.now() / 1_000);
    const old = await server.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${await token(now - 600)}` }, payload });
    expect(old.statusCode).toBe(401);
    expect(old.json()).toEqual({ code: 'BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED' });
    expect(service.grant).not.toHaveBeenCalled();
    await server.close();
  });

  it('refuses zero, negative, fractional and unkeyed grants at the boundary', async () => {
    const server = await app();
    const headers = { authorization: `Bearer ${await token(Math.floor(Date.now() / 1_000))}` };
    for (const body of [{ ...payload, credits: '0' }, { ...payload, credits: '-5' },
      { ...payload, credits: '1.5' }, { ...payload, reason: 'too short' },
      { ...payload, idempotency_key: 'not-hex' }, { ...payload, team_id: 't1' }]) {
      const response = await server.inject({ method: 'POST', url, headers, payload: body });
      expect(response.statusCode).toBe(400);
    }
    expect(service.grant).not.toHaveBeenCalled();
    await server.close();
  });

  it('passes the live actor and answers 201, then 200 for a replay', async () => {
    const server = await app();
    const headers = { authorization: `Bearer ${await token(Math.floor(Date.now() / 1_000))}` };
    service.grant.mockResolvedValueOnce(result).mockResolvedValueOnce({ ...result, replayed: true });
    const first = await server.inject({ method: 'POST', url, headers, payload });
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(service.grant).toHaveBeenCalledWith({ organisationId: 'org-1', credits: '10000',
      reason: 'Launch allowance for our team', idempotencyKey: 'b'.repeat(64),
      actor: { userId: 'operator', tokenVersion: 3, email: 'operator@example.com',
        domain: 'authentication.unlikeotherai.com' } });
    const replay = await server.inject({ method: 'POST', url, headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });
    await server.close();
  });
});
