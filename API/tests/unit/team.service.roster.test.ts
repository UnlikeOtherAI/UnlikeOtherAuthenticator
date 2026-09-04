import { describe, expect, it } from 'vitest';

import { findTeamMemberCandidates, listTeamMembers } from '../../src/services/team.service.js';
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

describe('Team roster contract', () => {
  useTeamServiceTestEnv();

  it('returns lifecycle status and display identity without email to an ordinary member', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-caller',
      orgId: org.id,
      userId: 'u-member',
      role: 'member',
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });
    prisma.teamMember.findMany.mockResolvedValue([
      {
        id: 'tm-deactivated',
        teamId: 'team-1',
        userId: 'u-person',
        teamRole: 'member',
        status: 'DEACTIVATED',
        createdAt: now,
        updatedAt: now,
        user: { id: 'u-person', name: 'Person', email: 'person@example.com' },
      },
    ]);
    prisma.teamMember.count.mockResolvedValue(1);

    const result = await listTeamMembers(
      {
        orgId: org.id,
        teamId: 'team-1',
        domain: org.domain,
        actorUserId: 'u-member',
        config: makeConfig(),
        status: 'DEACTIVATED',
      },
      { prisma },
    );

    expect(result).toMatchObject({
      total: 1,
      data: [{ subject: 'u-person', role: 'member', teamRole: 'member', status: 'DEACTIVATED' }],
      permissions: { addMember: false, viewMemberEmail: false },
    });
    expect(result.data[0].identity).toEqual({
      displayName: 'Person',
      avatarImageUrl: expect.any(String),
    });
    expect(prisma.teamMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teamId: 'team-1', status: 'DEACTIVATED' }),
      }),
    );
  });

  it('finds only active org members who are not already active in the target team', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-admin',
      orgId: org.id,
      userId: 'u-admin',
      role: 'admin',
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.orgMember.findMany.mockResolvedValue([
      {
        id: 'om-candidate',
        createdAt: now,
        userId: 'u-candidate',
        role: 'member',
        user: { id: 'u-candidate', name: 'Candidate Person', email: 'candidate@example.com' },
      },
    ]);
    prisma.orgMember.count.mockResolvedValue(1);

    const result = await findTeamMemberCandidates(
      {
        orgId: org.id,
        teamId: 'team-1',
        domain: org.domain,
        actorUserId: 'u-admin',
        config: makeConfig(),
        q: 'candidate',
        limit: 20,
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [
        { subject: 'u-candidate', orgRole: 'member', identity: { email: 'candidate@example.com' } },
      ],
      permissions: { addMember: true },
    });
    expect(prisma.orgMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: org.id,
          status: 'ACTIVE',
          user: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                teamMembers: { none: { teamId: 'team-1', status: 'ACTIVE' } },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('refuses candidate search before it can query a roster for a non-manager', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-member',
      orgId: org.id,
      userId: 'u-member',
      role: 'member',
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'member' });

    await expect(
      findTeamMemberCandidates(
        {
          orgId: org.id,
          teamId: 'team-1',
          domain: org.domain,
          actorUserId: 'u-member',
          config: makeConfig(),
          q: 'candidate',
        },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.findMany).not.toHaveBeenCalled();
  });
});
