import { describe, expect, it } from 'vitest';

import { getTeam } from '../../src/services/team.service.js';
import { makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// CLAUDE.md 500-line split: gap-fix A Task 2's `?include=invited` addendum on
// `GET /org/organisations/:orgId/teams/:teamId` (getTeam), split out of team.service.test.ts to
// keep that file under the 500-line cap.
describe('Team service: getTeam include=invited', () => {
  useTeamServiceTestEnv();

  it('include=invited: org owner/admin sees pending entries, incl. approvalStatus PENDING', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      members: [],
    });
    prisma.teamInvite.findMany.mockResolvedValue([
      {
        id: 'invite-approved',
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'approved@acme.com',
        inviteName: null,
        teamRole: 'member',
        redirectUrl: null,
        invitedByUserId: null,
        invitedByName: 'Alice Admin',
        invitedByEmail: 'alice@acme.com',
        acceptedUserId: null,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        openedAt: null,
        openCount: 2,
        lastSentAt: now,
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        approvalStatus: 'NOT_REQUIRED',
        requestedByUserId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'invite-pending-approval',
        orgId: 'org-1',
        teamId: 'team-1',
        email: 'pending@acme.com',
        inviteName: 'Pat Pending',
        teamRole: 'member',
        redirectUrl: null,
        invitedByUserId: null,
        invitedByName: null,
        invitedByEmail: 'bob@acme.com',
        acceptedUserId: null,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        openedAt: null,
        openCount: 0,
        lastSentAt: now,
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        approvalStatus: 'PENDING',
        requestedByUserId: 'u-requester',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await getTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        includeInvited: true,
      },
      { prisma },
    );

    expect(result.invited).toEqual([
      {
        inviteId: 'invite-approved',
        email: 'approved@acme.com',
        inviteName: null,
        teamRole: 'member',
        invitedByName: 'Alice Admin',
        invitedByEmail: 'alice@acme.com',
        lastSentAt: now,
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        approvalStatus: 'not_required',
        openCount: 2,
      },
      {
        inviteId: 'invite-pending-approval',
        email: 'pending@acme.com',
        inviteName: 'Pat Pending',
        teamRole: 'member',
        invitedByName: null,
        invitedByEmail: 'bob@acme.com',
        lastSentAt: now,
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        approvalStatus: 'pending',
        openCount: 0,
      },
    ]);
    expect(prisma.teamInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: 'org-1',
          teamId: 'team-1',
          approvalStatus: { in: ['NOT_REQUIRED', 'APPROVED', 'PENDING'] },
        }),
      }),
    );
  });

  it('include=invited: a plain member gets an empty array, never a 403', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-member',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      members: [],
    });
    // isOrgOrTeamManager's team-level fallback check: not a team owner/admin either.
    prisma.teamMember.findFirst.mockResolvedValue(null);

    const result = await getTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-member',
        includeInvited: true,
      },
      { prisma },
    );

    expect(result.invited).toEqual([]);
    expect(prisma.teamInvite.findMany).not.toHaveBeenCalled();
  });
});
