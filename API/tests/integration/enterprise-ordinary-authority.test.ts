import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { baseClientConfigPayload } from '../helpers/test-config.js';
import { validateConfigFields } from '../../src/services/config.service.js';
import { removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { revokeAllRefreshTokensForUser } from '../../src/services/refresh-token-revocation.service.js';
import { runEnterpriseAuthorityTransaction } from '../../src/services/enterprise-authority-transaction.service.js';
import { assertMailboxCredentialAdmission } from '../../src/services/credential-admission.service.js';
import { loginWithSocialProfile } from '../../src/services/social/social-login.service.js';

describe('ordinary authority changes publish exact enterprise revocations', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const prior = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL };
  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('A real isolated PostgreSQL DATABASE_URL is required');
    handle = created;
    process.env.DATABASE_URL = handle.databaseUrl;
    process.env.DATABASE_ADMIN_URL = handle.databaseUrl;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    await handle?.cleanup();
  });

  async function fixture() {
    const db = handle.prisma;
    const id = randomUUID();
    const domain = `ordinary-${id}.example.com`;
    const consumer = `consumer-${id}.example.com`;
    const owner = await db.user.create({ data: { email: `owner-${id}@example.test`, userKey: `owner-${id}` } });
    const user = await db.user.create({ data: { email: `user-${id}@example.test`, userKey: `user-${id}` } });
    const orgs = [];
    for (let index = 0; index < 2; index++) {
      const org = await db.organisation.create({ data: {
        domain, ownerId: owner.id, name: `Organisation ${index}`, slug: `org-${id}-${index}`,
      } });
      await db.orgMember.createMany({ data: [
        { orgId: org.id, userId: owner.id, role: 'owner' }, { orgId: org.id, userId: user.id, role: 'member' },
      ] });
      orgs.push(org);
      for (const issuingDomain of [domain, consumer]) {
        await db.refreshToken.create({ data: {
          userId: user.id, orgId: org.id, domain: issuingDomain, tokenHash: randomUUID(), familyId: randomUUID(),
          clientId: 'test-client', configUrl: `https://${issuingDomain}/config`,
          expiresAt: new Date(Date.now() + 3600000),
        } });
      }
    }
    const config = validateConfigFields(baseClientConfigPayload({ domain, org_features: { enabled: true } }));
    return { db, domain, consumer, owner, user, orgs, config };
  }

  it('removal rolls back membership, families and events together, then affects only that org', async () => {
    const { db, domain, consumer, user, orgs, config } = await fixture();
    const input = { domain, orgId: orgs[0].id, userId: user.id, config,
      actor: { via: 'domain_backend' as const, sourceDomain: domain } };
    await expect(removeOrganisationMember(input, { prisma: db,
      afterMembershipStatusWrite: async () => { throw new Error('abort authority write'); },
    })).rejects.toThrow('abort authority write');
    expect(await db.orgRevocationEvent.count({ where: { clientDomain: domain } })).toBe(0);
    expect(await db.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(4);
    expect((await db.orgMember.findUniqueOrThrow({ where: {
      orgId_userId: { orgId: orgs[0].id, userId: user.id },
    } })).status).toBe('ACTIVE');

    await removeOrganisationMember(input, { prisma: db });
    const events = await db.orgRevocationEvent.findMany({ where: { userId: user.id }, orderBy: { sequence: 'asc' } });
    expect(events.map(row => row.clientDomain).sort()).toEqual([domain, consumer].sort());
    expect(events.every(row => row.orgId === orgs[0].id && row.scope === 'organisation')).toBe(true);
    expect(await db.refreshToken.count({ where: { userId: user.id, orgId: orgs[0].id, revokedAt: null } })).toBe(0);
    expect(await db.refreshToken.count({ where: { userId: user.id, orgId: orgs[1].id, revokedAt: null } })).toBe(2);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(0);
  });

  it('global credential revocation reaches every consumer with its epoch in the same commit', async () => {
    const { db, domain, consumer, user } = await fixture();
    await expect(runEnterpriseAuthorityTransaction(db, async (tx) => {
      await revokeAllRefreshTokensForUser(user.id, { prisma: tx });
      throw new Error('credential write failed');
    })).rejects.toThrow('credential write failed');
    expect(await db.orgRevocationEvent.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(0);
    await revokeAllRefreshTokensForUser(user.id, { prisma: db });
    const events = await db.orgRevocationEvent.findMany({ where: { userId: user.id } });
    expect(events.map(row => row.clientDomain).sort()).toEqual([domain, consumer].sort());
    expect(events.every(row => row.scope === 'user' && !row.orgId && !row.teamId)).toBe(true);
    expect(await db.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(1);
  });

  it('past corporate-domain verification prevents pre-link mailbox and legacy social takeover', async () => {
    const { db, domain, user, orgs, config } = await fixture();
    const emailDomain = `${randomUUID()}.corporate.example`;
    const email = `person@${emailDomain}`;
    await db.user.update({ where: { id: user.id }, data: { email, userKey: email } });
    await assertMailboxCredentialAdmission(user.id, db);
    await db.organisationEmailDomain.create({ data: {
      clientDomain: domain, orgId: orgs[0].id, emailDomain, status: 'LAPSED',
      verifiedAt: new Date(), challengeHash: randomUUID(), challengeExpiresAt: new Date(),
    } });
    expect(await db.externalIdentity.count({ where: { userId: user.id } })).toBe(0);
    await expect(assertMailboxCredentialAdmission(user.id, db)).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    await expect(loginWithSocialProfile({ config, profile: {
      provider: 'google', email, emailVerified: true, name: 'Attacker supplied', avatarUrl: null,
    } }, { prisma: db })).rejects.toThrow('INDEPENDENT_REAUTH_REQUIRED');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBeNull();
  });
});
