import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { issueSessionAssurance, validateSessionAssurance } from '../../src/services/session-assurance.service.js';
import { revokeEnterpriseScope, lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';

describe('enterprise scoped authority transactions with real PostgreSQL', () => {
  let handle: RlsTestDbHandle;
  let app: PrismaClient;
  const userId = `sso-user-${randomUUID()}`;
  const domain = `sso-${randomUUID()}.example.com`;
  const orgA = `sso-org-a-${randomUUID()}`;
  const orgB = `sso-org-b-${randomUUID()}`;
  const now = new Date();
  beforeAll(async () => {
    const created = await createRlsTestDb();
    if (!created) throw new Error('DATABASE_URL must name a real isolated PostgreSQL test database');
    handle = created;
    app = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    await app.$connect();
    await handle.prisma.clientDomain.create({ data: { domain, label: 'SSO test' } });
    await handle.prisma.user.create({ data: { id: userId, email: `${userId}@example.com`, userKey: userId } });
    for (const id of [orgA, orgB]) {
      await handle.prisma.organisation.create({ data: { id, domain, name: id, slug: id, ownerId: userId } });
      await handle.prisma.orgMember.create({ data: { orgId: id, userId, role: 'owner' } });
      await handle.prisma.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: id } });
      await handle.prisma.refreshToken.create({ data: { tokenHash: `hash-${id}`, familyId: `family-${id}`,
        userId, domain, clientId: 'client', configUrl: `https://${domain}/config`, orgId: id,
        expiresAt: new Date(now.getTime() + 3600000) } });
    }
  });
  afterAll(async () => { await app?.$disconnect(); await handle?.cleanup(); });

  it('preserves two active memberships on the same origin', async () => {
    const memberships = await handle.prisma.orgMember.findMany({ where: { userId, status: 'ACTIVE' } });
    expect(memberships.map((m) => m.orgId).sort()).toEqual([orgA, orgB].sort());
  });
  it('rejects connection scope substitution structurally', async () => {
    const connection = await handle.prisma.orgSsoConnection.create({ data: {
      clientDomain: domain, orgId: orgA, protocol: 'oidc', preset: 'other_oidc', displayName: 'Provider', configuration: {},
    } });
    await expect(handle.prisma.externalIdentity.create({ data: { connectionId: connection.id,
      clientDomain: domain, orgId: orgB, userId, issuer: 'https://idp.example.com', tenant: 'tenant',
      subject: 'stable', identityScope: 'global', linkedVia: 'independent_session' } })).rejects.toThrow();
  });
  it('atomically rolls back revocation and outbox if authority mutation fails', async () => {
    await expect(handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await revokeEnterpriseScope({ clientDomain: domain, orgId: orgA, scope: 'product_org', revision: 2 }, tx);
      throw new Error('rollback proof');
    })).rejects.toThrow('rollback proof');
    expect(await handle.prisma.orgRevocationEvent.count({ where: { clientDomain: domain } })).toBe(0);
    expect((await handle.prisma.refreshToken.findFirstOrThrow({ where: { familyId: `family-${orgA}` } })).revokedAt).toBeNull();
  });
  it('revokes exact-org assurance/family without global epoch or sibling logout', async () => {
    const issued = await handle.prisma.$transaction((tx) => issueSessionAssurance({
      userId, credentialEpoch: 0, clientDomain: domain, orgId: orgA, teamId: null,
      familyId: `family-${orgA}`, method: 'independent', observedAt: now, authenticatedAt: now,
      mfaSource: 'none', amr: ['pwd'], policyGeneration: 1, expiresAt: new Date(now.getTime() + 1800000),
    }, tx));
    await validateSessionAssurance({ reference: issued.reference, userId, credentialEpoch: 0,
      clientDomain: domain, orgId: orgA }, handle.prisma);
    await handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      return revokeEnterpriseScope({ clientDomain: domain, orgId: orgA, scope: 'product_org', revision: 2 }, tx);
    });
    await expect(validateSessionAssurance({ reference: issued.reference, userId, credentialEpoch: 0,
      clientDomain: domain, orgId: orgA }, handle.prisma)).rejects.toThrow('INVALID_SESSION_ASSURANCE');
    expect((await handle.prisma.refreshToken.findFirstOrThrow({ where: { familyId: `family-${orgB}` } })).revokedAt).toBeNull();
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(0);
    expect(await handle.prisma.orgRevocationEvent.count({ where: { clientDomain: domain, orgId: orgA } })).toBe(1);
  });
  it('serializes event allocation through commit before a competing authority write', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { acquired = resolve; });
    const first = handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      const event = await tx.orgRevocationEvent.create({ data: { clientDomain: domain,
        orgId: orgA, scope: 'product_org', revision: 10 } });
      acquired();
      await blocked;
      return event;
    });
    await entered;
    let secondEntered = false;
    const second = handle.prisma.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      secondEntered = true;
      return tx.orgRevocationEvent.create({ data: { clientDomain: domain,
        orgId: orgA, scope: 'product_org', revision: 11 } });
    });
    try {
      await handle.prisma.$executeRaw`SELECT pg_sleep(0.1)`;
      expect(secondEntered).toBe(false);
    } finally { release(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.sequence < b.sequence).toBe(true);
  });
  it('makes the server assurance minimum monotonic', async () => {
    await handle.prisma.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1 } });
    await expect(handle.prisma.enterpriseProductReadiness.update({ where: { clientDomain: domain },
      data: { minimumAssuranceVersion: 0 } })).rejects.toThrow('cannot downgrade');
  });
  it('denies tenant SQL access to backend custody and foreign-product policy', async () => {
    expect(await app.sessionAssurance.findMany()).toEqual([]);
    const policies = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.domain', ${domain}, true)`;
      return tx.orgSsoPolicy.findMany();
    });
    expect(policies).toHaveLength(2);
    const foreign = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.domain', 'other.example.com', true)`;
      return tx.orgSsoPolicy.findMany();
    });
    expect(foreign).toEqual([]);
  });
});
