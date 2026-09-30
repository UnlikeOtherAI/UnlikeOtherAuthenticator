import { describe, expect, it } from 'vitest';
import { addOrganisationMember, changeOrganisationMemberRole, removeOrganisationMember } from '../../src/services/organisation.service.members.js';
import { transferOrganisationOwnership } from '../../src/services/organisation.service.ownership.js';
import { listOrganisationMembers } from '../../src/services/organisation.service.roster.js';
import { baseOrg, makeConfig, makePrismaMock, useOrganisationMembershipTestEnv } from './helpers/organisation-service-membership-test-helpers.js';

const params = { orgId: baseOrg.id, domain: baseOrg.domain, userId: 'u-legacy-owner', config: makeConfig() };

describe('Owner protection is independent of grants and owner counts', () => {
  useOrganisationMembershipTestEnv();
  for (const actorRole of ['owner', 'admin']) {
    it(`${actorRole} cannot remove or demote another owner when multiple owners remain`, async () => {
      for (const operation of ['remove', 'demote'] as const) {
        const prisma = makePrismaMock();
        prisma.organisation.findFirst.mockResolvedValue(baseOrg);
        prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) => Promise.resolve({
          id: args.where.userId, orgId: baseOrg.id, userId: args.where.userId,
          role: args.where.userId === 'u-actor' ? actorRole : 'owner',
        }));
        prisma.orgMember.count.mockResolvedValue(3);
        const input = { ...params, actorUserId: 'u-actor' };
        const run = operation === 'remove' ? removeOrganisationMember(input, { prisma })
          : changeOrganisationMemberRole({ ...input, role: 'member' }, { prisma });
        await expect(run).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        expect(prisma.orgMember.update).not.toHaveBeenCalled();
        expect(prisma.organisation.update).not.toHaveBeenCalled();
      }
    });
    it(`${actorRole} cannot mint an owner through add or ordinary role change`, async () => {
      const prisma = makePrismaMock();
      for (const run of [addOrganisationMember, changeOrganisationMemberRole]) {
        await expect(run({ ...params, actorUserId: 'u-actor', role: 'owner' }, { prisma }))
          .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      }
      expect(prisma.orgMember.create).not.toHaveBeenCalled();
      expect(prisma.orgMember.update).not.toHaveBeenCalled();
    });
  }

  it('advertises equal role management, and handover only for the active canonical owner', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      const prisma = makePrismaMock();
      prisma.organisation.findFirst.mockResolvedValue(baseOrg);
      prisma.orgMember.findFirst.mockResolvedValue({ id: 'm-actor', userId: baseOrg.ownerId, role });
      prisma.orgMember.findMany.mockResolvedValue([]); prisma.orgMember.count.mockResolvedValue(0);
      const roster = await listOrganisationMembers({ ...params, actorUserId: baseOrg.ownerId }, { prisma });
      expect(roster.permissions.changeMemberRole).toBe(role !== 'member');
      expect(roster.permissions.transferOwnership).toBe(role === 'owner');
      expect(roster.permissions.orgRoleOptions).not.toContain('owner');
    }
  });

  it('does not trust a canonical handle without active Owner membership', async () => {
    const prisma = makePrismaMock(); prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValue(null);
    await expect(transferOrganisationOwnership({ ...params, actorUserId: baseOrg.ownerId, newOwnerId: 'u-recipient' }, { prisma }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.organisation.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks canonical ownership after locking instead of transferring a stale snapshot', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValueOnce(baseOrg).mockResolvedValue({ ...baseOrg, ownerId: 'u-other-owner' });
    await expect(transferOrganisationOwnership({ ...params, actorUserId: baseOrg.ownerId, newOwnerId: 'u-recipient' }, { prisma }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.organisation.updateMany).not.toHaveBeenCalled();
    expect(prisma.orgMember.update).not.toHaveBeenCalled();
  });
});
