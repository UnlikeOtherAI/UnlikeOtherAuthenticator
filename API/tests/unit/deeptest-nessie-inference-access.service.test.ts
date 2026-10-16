import { BillingAppKeyPurpose } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT,
  getDeepTestNessieInferenceAccess,
  setDeepTestNessieInferenceAccess,
} from '../../src/services/deeptest-nessie-inference-access.service.js';
import type { VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';

const baseUrl = 'https://authentication.unlikeotherai.com';
const request = { product: 'deeptest', organisationId: 'org-1', teamId: 'team-1', userId: 'user-1' };
let credential: VerifiedBillingAppKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  credential = {
    id: 'key-1', purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
    actorIssuer: 'https://api.deeptest.live',
    actorAudience: `${baseUrl}/billing/v1/effective-tariff`, actorKeyId: 'deeptest-1',
    actorPublicJwk: { ...await exportJWK(pair.publicKey), kid: 'deeptest-1' },
    checkoutReturnOrigins: ['https://app.deeptest.live'],
    service: { id: 'service-1', identifier: 'deeptest', name: 'DeepTest' },
  };
});
afterEach(() => { vi.unstubAllEnvs(); });

async function actor(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ product: 'deeptest', organisation_id: 'org-1', team_id: 'team-1', tv: 0,
    sub: 'user-1', aud: `${baseUrl}${DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT}`, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'deeptest-1' })
    .setIssuer(credential.actorIssuer).setJti('request-1').setIssuedAt(now)
    .setExpirationTime(now + 60).sign(privateKey);
}

function setup(allowed = false) {
  vi.stubEnv('PUBLIC_BASE_URL', baseUrl);
  const user = { lifecycleStatus: 'ACTIVE', tokenVersion: 0, deeptestNessieInferenceAllowed: allowed };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn<(input: { where: { id: string } }) => Promise<Record<string, unknown> | null>>(async () => user), update: vi.fn().mockResolvedValue({}) },
    orgMember: { findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: 'membership-1' }) },
    billingAppKey: { findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: 'key-1' }) },
    domainRole: { findUnique: vi.fn().mockResolvedValue({ role: 'SUPERUSER' }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
  const read = async (overrides: Record<string, unknown> = {}) => getDeepTestNessieInferenceAccess(
    { credential, actorToken: await actor(overrides), request }, { prisma: prisma as never });
  return { user, tx, prisma, read };
}

describe('DeepTest Nessie inference permission', () => {
  it('defaults to deny and resolves an explicit permission afresh on every call', async () => {
    const s = setup();
    expect(await s.read()).toEqual({ allowed: false });
    s.user.deeptestNessieInferenceAllowed = true;
    expect(await s.read()).toEqual({ allowed: true });
    s.user.deeptestNessieInferenceAllowed = false;
    expect(await s.read()).toEqual({ allowed: false });
    expect(s.tx.user.findUnique).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['stale epoch', { tv: 1 }], ['missing epoch', { tv: undefined }],
    ['unsafe epoch', { tv: Number.MAX_SAFE_INTEGER + 1 }], ['different user', { sub: 'other' }],
    ['different team', { team_id: 'other' }], ['different organisation', { organisation_id: 'other' }],
    ['different product', { product: 'nessie' }], ['legacy audience', { aud: `${baseUrl}/billing/v1/effective-tariff` }],
  ])('rejects %s', async (_name, overrides) => {
    const s = setup(true);
    vi.stubEnv('BILLING_ACTOR_AUDIENCE_MODE', 'warn');
    await expect(s.read(overrides)).rejects.toMatchObject({ statusCode: expect.any(Number) });
  });

  it.each(['DISABLED', 'DELETING', 'DELETED'])('refuses a %s account even with permission', async (status) => {
    const s = setup(true);
    s.user.lifecycleStatus = status;
    await expect(s.read()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires exact ACTIVE org/team membership and current key state', async () => {
    const s = setup(true);
    s.tx.orgMember.findFirst.mockResolvedValueOnce(null);
    await expect(s.read()).rejects.toMatchObject({ statusCode: 403 });
    expect(s.tx.orgMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      userId: 'user-1', orgId: 'org-1', status: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE',
        teams: { some: { id: 'team-1', lifecycleStatus: 'ACTIVE',
          members: { some: { userId: 'user-1', status: 'ACTIVE' } } } } },
    } }));
    s.tx.billingAppKey.findFirst.mockResolvedValueOnce(null);
    await expect(s.read()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects sibling-product and entitlement credentials before reading identity', async () => {
    const s = setup(true);
    for (const key of [{ ...credential, purpose: BillingAppKeyPurpose.ENTITLEMENT },
      { ...credential, service: { ...credential.service, identifier: 'nessie' } }]) {
      await expect(getDeepTestNessieInferenceAccess({ credential: key, actorToken: await actor(), request },
        { prisma: s.prisma as never })).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(s.tx.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an assertion that expires while waiting for locks', async () => {
    const s = setup(true);
    await expect(getDeepTestNessieInferenceAccess({ credential, actorToken: await actor(), request },
      { prisma: s.prisma as never, now: () => Math.floor(Date.now() / 1000) + 61 }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(s.tx.user.findUnique).not.toHaveBeenCalled();
  });

  it('commits the exact operator decision and audit in one transaction', async () => {
    const s = setup();
    s.tx.user.findUnique.mockImplementation(async (input) => input.where.id === 'admin-1'
      ? { email: 'admin@example.test', lifecycleStatus: 'ACTIVE', tokenVersion: 3 } : s.user);
    expect(await setDeepTestNessieInferenceAccess({ userId: 'user-1', allowed: true,
      actor: { userId: 'admin-1', tokenVersion: 3 } }, { prisma: s.prisma as never }))
      .toEqual({ allowed: true });
    expect(s.tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' },
      data: { deeptestNessieInferenceAllowed: true } });
    expect(s.tx.adminAuditLog.create).toHaveBeenCalledWith({ data: {
      actorEmail: 'admin@example.test', action: 'user.deeptest_nessie_inference_changed',
      metadata: { userId: 'user-1', previousAllowed: false, allowed: true },
    } });
  });

  it('requires the current platform superuser epoch at mutation commit', async () => {
    const s = setup();
    await expect(setDeepTestNessieInferenceAccess({ userId: 'user-1', allowed: true,
      actor: { userId: 'admin-1', tokenVersion: 3 } }, { prisma: s.prisma as never }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(s.tx.user.update).not.toHaveBeenCalled();
    expect(s.tx.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
