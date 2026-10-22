import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { pruneEnterpriseTransients, recheckEnterpriseDomains } from '../../src/services/enterprise-maintenance.service.js';
import { hashAssuranceReference } from '../../src/services/session-assurance.service.js';
import { assertEnterpriseProvisioningActive } from '../../src/services/enterprise-identity-status.service.js';
import { replaceManagedMemberships } from '../../src/services/membership-provenance.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('bounded enterprise lifecycle maintenance with real PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let connection: string; let claim: string; let identity: string;
  const suffix = randomUUID(); const domain = `maintenance-${suffix}.example.com`; const org = `org-${suffix}`;
  const owner = `owner-${suffix}`; const user = `person-${suffix}`; const team = `team-${suffix}`;
  beforeAll(async () => {
    const created = await createRlsTestDb(); if (!created) throw new Error('DATABASE_URL required for maintenance coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'Maintenance' } });
    await db.user.createMany({ data: [owner, user].map((id) => ({ id, userKey: id, email: `${id}@example.com` })) });
    await db.organisation.create({ data: { id: org, domain, ownerId: owner, name: 'Maintenance', slug: org } });
    await db.orgMember.create({ data: { orgId: org, userId: owner, role: 'owner' } });
    await db.team.create({ data: { id: team, orgId: org, name: 'Team', slug: team } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: org } });
    connection = (await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: org, protocol: 'oidc', preset: 'other_oidc',
      displayName: 'Test', configuration: {} } })).id;
    claim = (await db.organisationEmailDomain.create({ data: { clientDomain: domain, orgId: org, emailDomain: 'corporate.example.com',
      status: 'VERIFIED', verifiedAt: new Date(Date.now() - 25 * 3600000), lastVerifiedAt: new Date(Date.now() - 25 * 3600000),
      checkedAt: new Date(Date.now() - 8 * 3600000), challengeHash: hashAssuranceReference('expected-proof'), challengeExpiresAt: new Date() } })).id;
    identity = (await db.externalIdentity.create({ data: { connectionId: connection, clientDomain: domain, orgId: org,
      userId: user, issuer: 'issuer', tenant: 'tenant', subject: 'subject', identityScope: 'global', linkedVia: 'verified_domain_jit', domainClaimId: claim } })).id;
    await db.$transaction(async (tx) => { await lockEnterpriseOutbox(tx); await replaceManagedMemberships({ userId: user,
      orgId: org, clientDomain: domain, connectionId: connection, sourceKind: 'sso', sourceId: identity,
      grants: [{ teamId: null, role: 'member', resourceId: 'identity' }, { teamId: team, role: 'member', resourceId: 'default' }] }, tx); });
  });
  afterAll(async () => { stores.db = null; await db?.$disconnect(); await handle?.cleanup(); });
  it('fails proof use when DNS freshness expires even before the scheduler runs, then atomically lapses its sources', async () => {
    await expect(assertEnterpriseProvisioningActive(connection, identity, user, db)).rejects.toThrow();
    await recheckEnterpriseDomains(async () => [['foreign-proof']], db);
    expect((await db.organisationEmailDomain.findUniqueOrThrow({ where: { id: claim } })).status).toBe('LAPSED');
    expect((await db.externalIdentity.findUniqueOrThrow({ where: { id: identity } })).status).toBe('SUSPENDED');
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId: team, userId: user } } })).status).toBe('DEACTIVATED');
    expect(await db.orgRevocationEvent.count({ where: { connectionId: connection, userId: user } })).toBeGreaterThan(0);
  });
  it('renews only exact TXT matches and keeps source suspension until explicit independent repair', async () => {
    await db.organisationEmailDomain.update({ where: { id: claim }, data: { status: 'VERIFIED', checkedAt: new Date(Date.now() - 8 * 3600000) } });
    await recheckEnterpriseDomains(async () => [['expected-', 'proof']], db);
    const row = await db.organisationEmailDomain.findUniqueOrThrow({ where: { id: claim } });
    expect(row.failures).toBe(0); expect(row.lastVerifiedAt?.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect((await db.externalIdentity.findUniqueOrThrow({ where: { id: identity } })).status).toBe('SUSPENDED');
  });
  it('bounds expired replay cleanup and preserves a live account-link child of an expired protocol flow', async () => {
    await db.orgSsoReplay.createMany({ data: Array.from({ length: 201 }, (_, index) => ({ key: `expired-${index}`, value: 'opaque', expiresAt: new Date(0) })) });
    await db.nativeOAuthFlow.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
      id: `expired-native-${index}`, browserHash: 'hash', context: {}, expiresAt: new Date(0) })) });
    await db.nativeOAuthFlow.create({ data: { id: 'live-native', browserHash: 'hash', context: {}, expiresAt: new Date(Date.now() + 60000) } });
    const flow = `flow-${suffix}`;
    await db.orgSsoFlow.create({ data: { id: flow, connectionId: connection, revision: 1, browserHash: 'hash', nonce: 'nonce',
      encryptedVerifier: 'sealed', mode: 'login', context: {}, expiresAt: new Date(0) } });
    await db.orgSsoLinkIntent.create({ data: { connectionId: connection, revision: 1, generation: 1, clientDomain: domain,
      orgId: org, flowId: flow, browserHash: 'hash', identity: {}, context: {}, expiresAt: new Date(Date.now() + 60000) } });
    await pruneEnterpriseTransients(db);
    expect(await db.orgSsoReplay.count()).toBe(1);
    expect(await db.nativeOAuthFlow.count()).toBe(2);
    expect(await db.nativeOAuthFlow.findUnique({ where: { id: 'live-native' } })).not.toBeNull();
    expect(await db.orgSsoFlow.findUnique({ where: { id: flow } })).not.toBeNull();
    await db.orgSsoLinkIntent.updateMany({ data: { expiresAt: new Date(0) } });
    await pruneEnterpriseTransients(db);
    expect(await db.orgSsoFlow.findUnique({ where: { id: flow } })).toBeNull();
    expect(await db.externalIdentity.count({ where: { id: identity } })).toBe(1);
  });
});
