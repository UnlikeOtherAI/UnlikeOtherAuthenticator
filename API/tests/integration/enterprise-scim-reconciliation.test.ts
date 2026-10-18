import { updateEnterprisePolicy, EnterprisePolicyPatch } from '../../src/services/org-sso-policy-management.service.js';
import { groupMappingView } from '../../src/services/enterprise-group-mapping.service.js';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRlsTestDb, type RlsTestDbHandle } from '../helpers/test-db.js';
import { authenticateScim, issueScimToken, mutateScimResource } from '../../src/services/enterprise-scim.service.js';
import { reconcileScimResource } from '../../src/services/enterprise-scim-reconciliation.service.js';
import { lockEnterpriseOutbox } from '../../src/services/org-sso-revocation.service.js';
import { assertEnterpriseIdentityNotErased, assertEnterpriseProvisioningActive } from '../../src/services/enterprise-identity-status.service.js';
import { eraseEnterprisePerson } from '../../src/services/enterprise-identity-retention.service.js';
import { SCIM_GROUP, SCIM_USER } from '../../src/services/enterprise-scim-protocol.service.js';

const stores = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => stores.db, getPrisma: () => stores.db }));
describe('SCIM reconciliation and erasure with real PostgreSQL', () => {
  let handle: RlsTestDbHandle; let db: PrismaClient; let app: PrismaClient;
  let connectionId: string; let externalIdentityId: string; let bearer: string; let resourceId: string;
  const suffix = randomUUID(); const domain = `scim-${suffix}.example.com`;
  const ownerId = `owner-${suffix}`; const userId = `person-${suffix}`; const orgId = `org-${suffix}`; const teamId = `team-${suffix}`;
  const tuple = { issuer: 'https://idp.example.com', tenant: 'tenant', subject: `stable-${suffix}` };
  beforeAll(async () => {
    const created = await createRlsTestDb();
    if (!created) throw new Error('DATABASE_URL required for SCIM transaction coverage');
    handle = created; db = new PrismaClient({ datasources: { db: { url: handle.adminDatabaseUrl } } });
    app = new PrismaClient({ datasources: { db: { url: handle.appDatabaseUrl } } });
    await db.$connect(); stores.db = db;
    await db.clientDomain.create({ data: { domain, label: 'SCIM test' } });
    await db.user.createMany({ data: [ownerId, userId].map((id) => ({ id, userKey: id, email: `${id}@example.com` })) });
    await db.organisation.create({ data: { id: orgId, domain, ownerId, name: 'SCIM', slug: orgId } });
    await db.orgMember.create({ data: { orgId, userId: ownerId, role: 'owner' } });
    await db.team.create({ data: { id: teamId, orgId, name: 'Team', slug: teamId } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId, arrangementEnabled: true,
      defaultTeamId: teamId } });
    await db.enterpriseProductReadiness.create({ data: { clientDomain: domain, minimumAssuranceVersion: 1,
      authorityMigrationRevision: 'migration-tested', revocationConsumersRevision: 'consumers-tested' } });
    const connection = await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId, preset: 'other_oidc',
      protocol: 'oidc', displayName: 'SCIM', configuration: {}, scimEnabled: true } });
    connectionId = connection.id;
    await db.orgSsoPolicy.update({ where: { clientDomain_orgId: { clientDomain: domain, orgId } }, data: {
      groupMappings: [{ connection_id: connectionId, external_group_id: 'group-external', team_id: teamId, team_role: 'admin' }] } });
    const identity = await db.externalIdentity.create({ data: { connectionId, clientDomain: domain, orgId, userId,
      ...tuple, identityScope: 'global', linkedVia: 'independent_proof' } });
    externalIdentityId = identity.id;
    bearer = `Bearer ${(await db.$transaction((tx) => issueScimToken(connectionId, tx))).token}`;
  }, 120000);
  afterAll(async () => { stores.db = null; await app?.$disconnect(); await db?.$disconnect(); await handle?.cleanup(); });

  it('rejects foreign provider mappings and exposes old unscoped mappings only as repair metadata', async () => {
    const foreignOrg = await db.organisation.create({ data: { domain, ownerId, name: 'Foreign scope', slug: randomUUID() } });
    await db.orgSsoPolicy.create({ data: { clientDomain: domain, orgId: foreignOrg.id } });
    const foreign = await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId: foreignOrg.id,
      protocol: 'oidc', preset: 'other_oidc', displayName: 'Foreign', configuration: {} } });
    const revision = (await db.orgSsoPolicy.findUniqueOrThrow({ where: { clientDomain_orgId: { clientDomain: domain, orgId } } })).revision;
    await expect(db.$transaction(async tx => { await lockEnterpriseOutbox(tx);
      return updateEnterprisePolicy({ userId: ownerId, orgId, clientDomain: domain } as Parameters<typeof updateEnterprisePolicy>[0],
        { revision, group_mappings: [{ connection_id: foreign.id, external_group_id: 'group-external', team_id: teamId, team_role: 'admin' }] }, tx);
    })).rejects.toThrow('SSO_CONNECTION_UNAVAILABLE');
    expect(EnterprisePolicyPatch.safeParse({ revision, group_mappings: [{ external_group_id: 'group-external', team_id: teamId, team_role: 'admin' }] }).success).toBe(false);
    expect(EnterprisePolicyPatch.safeParse({ revision, group_mappings: [{ connection_id: connectionId, external_group_id: 'group-external', team_id: teamId, team_role: 'owner' }] }).success).toBe(false);
    expect(groupMappingView([{ external_group_id: 'unscoped', team_id: teamId, team_role: 'admin' }], [connectionId], [teamId]))
      .toEqual({ group_mappings: [], invalid_group_mappings: 1 });
  });
  it('stages resources without email linking, rejects cross-connection members, and checks token scope', async () => {
    const row = await mutateScimResource(connectionId, 'Users', { schemas: [SCIM_USER], externalId: 'upstream-user',
      userName: `${userId}@example.com`, active: true }, { bearer });
    if (!row) throw new Error('Expected SCIM resource'); resourceId = row.id;
    expect((await mutateScimResource(connectionId, 'Users', { active: true, userName: `${userId}@example.com`,
      externalId: 'upstream-user', schemas: [SCIM_USER] }, { bearer }))?.id).toBe(resourceId);
    expect((await db.scimResourceLink.findUniqueOrThrow({ where: { id: resourceId } })).userId).toBeNull();
    expect(await db.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } } })).toBeNull();
    await expect(mutateScimResource(connectionId, 'Groups', { schemas: [SCIM_GROUP], displayName: 'Bad',
      members: [{ value: externalIdentityId }] }, { bearer })).rejects.toThrow('SCIM_INVALID_MEMBER');
    await expect(authenticateScim('foreign-connection', bearer, db)).rejects.toThrow();
    expect(await db.scimResourceLink.count({ where: { resourceType: 'Groups' } })).toBe(0);
  });
  it('reconciles only a proved stable identity and prevents direct binding mutation with absent erasure setting', async () => {
    await db.$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await reconcileScimResource({ connectionId, resourceId, externalIdentityId, version: 1, actorUserId: ownerId }, tx);
    });
    expect((await db.scimResourceLink.findUniqueOrThrow({ where: { id: resourceId } })).subjectBinding).toBe(externalIdentityId);
    await expect(db.scimResourceLink.update({ where: { id: resourceId }, data: { userId: ownerId } })).rejects.toThrow('immutable');
    await mutateScimResource(connectionId, 'Groups', { schemas: [SCIM_GROUP], externalId: 'group-external', displayName: 'Admins',
      members: [{ value: resourceId, '$ref': null }] }, { bearer });
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId } } })).teamRole).toBe('admin');
    expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId } } })).role).toBe('member');
  });
  it('does not borrow a same-named group mapping from another connection', async () => {
    const secondUser = await db.user.create({ data: { userKey: randomUUID(), email: `${randomUUID()}@example.com` } });
    const connection = await db.orgSsoConnection.create({ data: { clientDomain: domain, orgId, preset: 'other_oidc',
      protocol: 'oidc', displayName: 'Second source', configuration: {}, scimEnabled: true } });
    const identity = await db.externalIdentity.create({ data: { connectionId: connection.id, clientDomain: domain, orgId,
      userId: secondUser.id, ...tuple, subject: randomUUID(), identityScope: 'global', linkedVia: 'independent_proof' } });
    const token = `Bearer ${(await db.$transaction(tx => issueScimToken(connection.id, tx))).token}`;
    const resource = await mutateScimResource(connection.id, 'Users', { schemas: [SCIM_USER], externalId: randomUUID(),
      userName: secondUser.email, active: true }, { bearer: token });
    if (!resource) throw new Error('Expected resource');
    await db.$transaction(async tx => { await lockEnterpriseOutbox(tx);
      await reconcileScimResource({ connectionId: connection.id, resourceId: resource.id,
        externalIdentityId: identity.id, version: 1, actorUserId: ownerId }, tx); });
    await mutateScimResource(connection.id, 'Groups', { schemas: [SCIM_GROUP], externalId: 'group-external', displayName: 'Same id',
      members: [{ value: resource.id }] }, { bearer: token });
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId: secondUser.id } } })).teamRole).toBe('member');
  });
  it('deprovisions transactionally while preserving an independent manual grant and blocking SSO proof reuse', async () => {
    await db.teamMember.update({ where: { teamId_userId: { teamId, userId } }, data: { teamRole: 'member' } });
    await mutateScimResource(connectionId, 'Users', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }] }, { id: resourceId, patch: true, bearer });
    expect((await db.teamMember.findUniqueOrThrow({ where: { teamId_userId: { teamId, userId } } })).status).toBe('ACTIVE');
    await expect(assertEnterpriseProvisioningActive(connectionId, externalIdentityId, userId, db)).rejects.toThrow();
    expect(await db.orgRevocationEvent.count({ where: { connectionId, userId } })).toBeGreaterThan(0);
    await expect(mutateScimResource(connectionId, 'Users', { schemas: [SCIM_USER], userName: 'changed' },
      { id: resourceId, bearer, ifMatch: 'W/"1"' })).rejects.toThrow('SCIM_VERSION_MISMATCH');
  });
  it('erases private attributes while preserving immutable opaque provisioning and upstream tuple tombstones', async () => {
    await db.user.update({ where: { id: userId }, data: { lifecycleStatus: 'DELETING' } });
    await db.$transaction(async (tx) => { await lockEnterpriseOutbox(tx); await eraseEnterprisePerson(userId, tx); }, { timeout: 30000 });
    const resource = await db.scimResourceLink.findUniqueOrThrow({ where: { id: resourceId } });
    expect(resource).toMatchObject({ userId: null, externalId: null, active: false, subjectBinding: externalIdentityId });
    expect(resource.attributes).toEqual({ schemas: [SCIM_USER], active: false });
    expect(resource.deletedAt).not.toBeNull();
    expect(await db.externalIdentity.count({ where: { userId } })).toBe(0);
    await expect(assertEnterpriseIdentityNotErased({ connectionId, ...tuple }, db)).rejects.toThrow();
    expect(await app.externalIdentityTombstone.count()).toBe(0);
    const tombstone = await db.externalIdentityTombstone.findFirstOrThrow();
    expect(JSON.stringify(tombstone)).not.toContain(tuple.subject);
    await expect(db.externalIdentityTombstone.delete({ where: { id: tombstone.id } })).rejects.toThrow();
    await expect(db.scimResourceLink.update({ where: { id: resourceId }, data: { active: true, deletedAt: null } })).rejects.toThrow();
    await db.user.delete({ where: { id: userId } });
    expect(await db.user.findUnique({ where: { id: userId } })).toBeNull();
    await expect(assertEnterpriseIdentityNotErased({ connectionId, ...tuple }, db)).rejects.toThrow();
  });
});
