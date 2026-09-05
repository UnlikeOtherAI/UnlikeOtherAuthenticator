import { describe, expect, it } from 'vitest';

import { listMemberTeamAccess } from '../../src/services/member-team-access.service.js';
import {
  makeConfig,
  makePrismaMock,
  now,
  useTeamServiceTestEnv,
} from './helpers/team-service-test-helpers.js';

const org = {
  id: 'org-1',
  domain: 'acme.example.com',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'u-owner',
  createdAt: now,
  updatedAt: now,
};

describe('member team access', () => {
  useTeamServiceTestEnv();

  it('returns only teams the caller can manage with the target membership state', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'om-caller', orgId: org.id, userId: 'u-manager', role: 'member' })
      .mockResolvedValueOnce({ id: 'om-target', orgId: org.id, userId: 'u-target', role: 'member' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team-managed', teamRole: 'admin' }]);
    prisma.team.findMany.mockResolvedValue([
      {
        id: 'team-managed',
        name: 'Product',
        slug: 'product',
        members: [{ id: 'tm-target' }],
      },
    ]);

    const result = await listMemberTeamAccess(
      {
        orgId: org.id,
        domain: org.domain,
        actorUserId: 'u-manager',
        userId: 'u-target',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'team-managed', name: 'Product', hasAccess: true }],
      permissions: { changeTeamAccess: true },
    });
    expect(prisma.team.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { orgId: org.id, id: { in: ['team-managed'] } },
    }));
  });

  it('does not disclose teams to a member without team-management authority', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'om-caller', orgId: org.id, userId: 'u-member', role: 'member' })
      .mockResolvedValueOnce({ id: 'om-target', orgId: org.id, userId: 'u-target', role: 'member' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team-1', teamRole: 'member' }]);

    await expect(listMemberTeamAccess(
      {
        orgId: org.id,
        domain: org.domain,
        actorUserId: 'u-member',
        userId: 'u-target',
        config: makeConfig(),
      },
      { prisma },
    )).resolves.toEqual({ data: [], permissions: { changeTeamAccess: false } });
    expect(prisma.team.findMany).not.toHaveBeenCalled();
  });
});
