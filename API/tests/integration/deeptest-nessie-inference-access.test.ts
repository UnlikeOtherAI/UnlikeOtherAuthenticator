import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getAdminAuthDomain } from '../../src/config/env.js';
import { createBillingAppKey, verifyBillingAppKey, type VerifiedBillingAppKey } from '../../src/services/billing-app-key.service.js';
import {
  DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT,
  getDeepTestNessieInferenceAccess,
  setDeepTestNessieInferenceAccess,
} from '../../src/services/deeptest-nessie-inference-access.service.js';
import { lockProductTeamPolicyExclusive } from '../../src/services/product-team-policy-lock.service.js';
import { createTestDb } from '../helpers/test-db.js';

describe.skipIf(!process.env.DATABASE_URL)('DeepTest Nessie permission persistence', () => {
  let db: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let privateKey: CryptoKey;
  let credential: VerifiedBillingAppKey;
  let userId: string;
  let orgId: string;
  let teamId: string;
  const operator = { userId: 'operator', tokenVersion: 0 };
  const publicBase = 'https://authentication.unlikeotherai.com';

  beforeAll(async () => {
    vi.stubEnv('PUBLIC_BASE_URL', publicBase);
    db = (await createTestDb())!;
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = { ...await exportJWK(pair.publicKey), kid: 'deeptest-test' };
    await db.prisma.user.create({ data: { id: operator.userId,
      email: 'operator@example.test', userKey: 'operator@example.test' } });
    await db.prisma.domainRole.create({ data: {
      userId: operator.userId, domain: getAdminAuthDomain(), role: 'SUPERUSER' } });
    const user = await db.prisma.user.create({ data: {
      email: 'person@example.test', userKey: 'person@example.test' } });
    userId = user.id;
    expect(user.deeptestNessieInferenceAllowed).toBe(false);
    const org = await db.prisma.organisation.create({ data: {
      name: 'Test organisation', slug: 'test-org', domain: 'api.deeptest.live', ownerId: userId } });
    orgId = org.id;
    const team = await db.prisma.team.create({ data: {
      name: 'Test team', slug: 'test', orgId, isDefault: true } });
    teamId = team.id;
    await db.prisma.orgMember.create({ data: { userId, orgId, role: 'owner' } });
    await db.prisma.teamMember.create({ data: { userId, teamId, teamRole: 'owner' } });
    const service = await db.prisma.billingService.create({ data: { identifier: 'deeptest', name: 'DeepTest' } });
    const key = await createBillingAppKey({ serviceId: service.id, purpose: 'customer_lifecycle',
      name: 'DeepTest test key', actorIssuer: 'https://api.deeptest.live',
      actorAudience: `${publicBase}/billing/v1/effective-tariff`, actorPublicJwk: jwk,
      checkoutReturnOrigins: ['https://app.deeptest.live'] }, { prisma: db.prisma });
    credential = await verifyBillingAppKey(key.plaintext, { prisma: db.prisma });
  });

  afterAll(async () => { await db?.cleanup(); vi.unstubAllEnvs(); });

  async function read(tv = 0) {
    const token = await new SignJWT({ product: 'deeptest', organisation_id: orgId, team_id: teamId, tv })
      .setProtectedHeader({ alg: 'RS256', kid: credential.actorKeyId })
      .setSubject(userId).setIssuer(credential.actorIssuer)
      .setAudience(`${publicBase}${DEEPTEST_NESSIE_INFERENCE_ACCESS_ENDPOINT}`)
      .setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(privateKey);
    return getDeepTestNessieInferenceAccess({ credential, actorToken: token,
      request: { product: 'deeptest', organisationId: orgId, teamId, userId } }, { prisma: db.prisma });
  }
  const set = (allowed: boolean) => setDeepTestNessieInferenceAccess({ userId, allowed, actor: operator }, { prisma: db.prisma });

  it('persists audited grant and revoke with no role-based implicit grant', async () => {
    expect(await read()).toEqual({ allowed: false });
    await set(true);
    expect(await read()).toEqual({ allowed: true });
    await set(false);
    expect(await read()).toEqual({ allowed: false });
    expect(await db.prisma.adminAuditLog.count({ where: {
      action: 'user.deeptest_nessie_inference_changed', metadata: { path: ['userId'], equals: userId } } })).toBe(2);
  });

  it('rolls back permission when the audit cannot commit', async () => {
    await expect(db.prisma.$transaction(async (tx) => setDeepTestNessieInferenceAccess({
      userId, allowed: true, actor: operator }, { prisma: { ...tx, adminAuditLog: {
        create: async () => { throw new Error('audit unavailable'); },
      } } as unknown as typeof db.prisma }))).rejects.toThrow('audit unavailable');
    expect(await read()).toEqual({ allowed: false });
  });

  it('reads the committed revocation after a competing writer releases policy lock', async () => {
    await set(true);
    let release!: () => void;
    let writerReady!: () => void;
    const ready = new Promise<void>((resolve) => { writerReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.prisma.$transaction(async (tx) => {
      await lockProductTeamPolicyExclusive(tx);
      await tx.user.update({ where: { id: userId }, data: { deeptestNessieInferenceAllowed: false } });
      writerReady();
      await gate;
    });
    await ready;
    const reader = read();
    release();
    await writer;
    expect(await reader).toEqual({ allowed: false });
  });

  it('refuses membership removal, stale epochs and suspended containers', async () => {
    await set(true);
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status: 'REMOVED' } });
    await expect(read()).rejects.toMatchObject({ statusCode: 403 });
    await db.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { status: 'ACTIVE' } });
    await db.prisma.user.update({ where: { id: userId }, data: { tokenVersion: 1 } });
    await expect(read()).rejects.toMatchObject({ statusCode: 403 });
    expect(await read(1)).toEqual({ allowed: true });
    await db.prisma.organisation.update({ where: { id: orgId }, data: { lifecycleStatus: 'DISABLED' } });
    await expect(read(1)).rejects.toMatchObject({ statusCode: 403 });
  });
});
