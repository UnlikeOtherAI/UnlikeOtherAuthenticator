import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { createTestUser } from '../helpers/org-user-endpoints-helper.js';
import { transferOrganisationOwnership } from '../../src/services/organisation.service.ownership.js';
import { changeOrganisationMemberRole, removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { deactivateOrganisationMember } from '../../src/services/organisation.service.lifecycle.js';
import type { ClientConfig } from '../../src/services/config.service.js';

const config = { org_features: { enabled: true, org_roles: ['owner', 'admin', 'member'] } } as ClientConfig;

describe.skipIf(!process.env.DATABASE_URL)('locked ownership writes', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const originalUrl = process.env.DATABASE_URL;
  let ids: { orgId: string; owner: string; admin: string; member: string; legacyOwner: string };
  beforeAll(async () => {
    const result = await createTestDb(); if (!result) throw new Error('Database required');
    handle = result; process.env.DATABASE_URL = handle.databaseUrl;
  });
  afterAll(async () => { process.env.DATABASE_URL = originalUrl; await handle?.cleanup(); });
  beforeEach(async () => {
    await handle.prisma.organisation.deleteMany(); await handle.prisma.user.deleteMany();
    const users = await Promise.all(['owner', 'admin', 'member', 'legacy-owner'].map((label) => createTestUser(handle, `${label}@ownership.example.com`)));
    const org = await handle.prisma.organisation.create({ data: { domain: 'ownership.example.com', name: 'Ownership', slug: 'ownership', ownerId: users[0].id } });
    ids = { orgId: org.id, owner: users[0].id, admin: users[1].id, member: users[2].id, legacyOwner: users[3].id };
    await handle.prisma.orgMember.createMany({ data: users.map((user, i) => ({ orgId: org.id, userId: user.id, role: ['owner', 'admin', 'member', 'owner'][i] })) });
  });
  const base = () => ({ orgId: ids.orgId, domain: 'ownership.example.com', config });

  it('protects multiple owners from Owner and Admin removal, deactivation and demotion', async () => {
    for (const actorUserId of [ids.owner, ids.admin]) {
      const params = { ...base(), actorUserId, userId: ids.legacyOwner };
      for (const operation of [
        () => removeOrganisationMember(params, { prisma: handle.prisma }),
        () => deactivateOrganisationMember(params, { prisma: handle.prisma }),
        () => changeOrganisationMemberRole({ ...params, role: 'member' }, { prisma: handle.prisma }),
      ]) await expect(operation()).rejects.toMatchObject({ statusCode: 400 });
    }
  });
  it('only one simultaneous handover may use the old canonical owner', async () => {
    const results = await Promise.allSettled([ids.member, ids.admin].map((newOwnerId) => transferOrganisationOwnership({
      ...base(), actorUserId: ids.owner, newOwnerId, previousOwnerRole: 'admin',
    }, { prisma: handle.prisma })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const org = await handle.prisma.organisation.findUniqueOrThrow({ where: { id: ids.orgId } });
    const members = await handle.prisma.orgMember.findMany({ where: { orgId: ids.orgId } });
    expect(members.find((m) => m.userId === org.ownerId)).toMatchObject({ role: 'owner', status: 'ACTIVE' });
    expect(members.find((m) => m.userId === ids.owner)?.role).toBe('admin');
    expect(members.filter((m) => m.role === 'owner')).toHaveLength(2);
  });
  it('handover racing deactivation never installs an inactive owner', async () => {
    const results = await Promise.allSettled([
      transferOrganisationOwnership({ ...base(), actorUserId: ids.owner, newOwnerId: ids.member }, { prisma: handle.prisma }),
      deactivateOrganisationMember({ ...base(), actorUserId: ids.admin, userId: ids.member }, { prisma: handle.prisma }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const org = await handle.prisma.organisation.findUniqueOrThrow({ where: { id: ids.orgId } });
    const owner = await handle.prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org.id, userId: org.ownerId } } });
    expect(owner).toMatchObject({ role: 'owner', status: 'ACTIVE' });
  });
  it('ignores stale role claims and refuses inactive or foreign recipients', async () => {
    const params = { ...base(), actorUserId: ids.owner, newOwnerId: ids.member };
    await handle.prisma.orgMember.update({ where: { orgId_userId: { orgId: ids.orgId, userId: ids.owner } }, data: { status: 'DEACTIVATED' } });
    await expect(transferOrganisationOwnership(params, { prisma: handle.prisma })).rejects.toMatchObject({ statusCode: 403 });
    await handle.prisma.orgMember.update({ where: { orgId_userId: { orgId: ids.orgId, userId: ids.owner } }, data: { status: 'ACTIVE' } });
    await handle.prisma.orgMember.update({ where: { orgId_userId: { orgId: ids.orgId, userId: ids.member } }, data: { status: 'DEACTIVATED' } });
    await expect(transferOrganisationOwnership(params, { prisma: handle.prisma })).rejects.toMatchObject({ statusCode: 404 });
    await expect(transferOrganisationOwnership({ ...params, newOwnerId: 'foreign-subject' }, { prisma: handle.prisma })).rejects.toMatchObject({ statusCode: 404 });
  });
});
