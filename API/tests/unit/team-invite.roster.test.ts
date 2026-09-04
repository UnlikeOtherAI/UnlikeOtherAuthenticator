import { describe, expect, it } from 'vitest';

import {
  listInvitationTargets,
  listPendingInvitations,
} from '../../src/services/team-invite.service.js';
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

describe('team invitation roster', () => {
  useTeamServiceTestEnv();

  it('offers only the exact teams a team-level member manager may invite to', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-member',
      orgId: org.id,
      userId: 'u-manager',
      role: 'member',
    });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team-2', teamRole: 'admin' }]);
    prisma.team.findMany.mockResolvedValue([
      { id: 'team-2', name: 'Product', slug: 'product', createdAt: now },
    ]);
    prisma.team.count.mockResolvedValue(1);

    const result = await listInvitationTargets(
      {
        orgId: org.id,
        domain: org.domain,
        actorUserId: 'u-manager',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'team-2', name: 'Product' }],
      total: 1,
      permissions: { createInvitation: true },
    });
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['team-2'] } }) }),
    );
  });

  it('returns actionable invitations with their explicit target team and a stable total', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-owner',
      orgId: org.id,
      userId: 'u-owner',
      role: 'owner',
    });
    prisma.teamInvite.findMany.mockResolvedValue([
      {
        id: 'invite-1',
        orgId: org.id,
        teamId: 'team-2',
        email: 'person@example.com',
        inviteName: 'Person',
        teamRole: 'member',
        redirectUrl: null,
        invitedByUserId: 'u-owner',
        invitedByName: 'Owner',
        invitedByEmail: 'owner@example.com',
        acceptedUserId: null,
        acceptedAt: null,
        declinedAt: null,
        revokedAt: null,
        revokedReason: null,
        openedAt: null,
        openCount: 0,
        lastSentAt: now,
        expiresAt: new Date('2026-03-01T00:00:00.000Z'),
        approvalStatus: 'NOT_REQUIRED',
        requestedByUserId: null,
        createdAt: now,
        updatedAt: now,
        team: { id: 'team-2', name: 'Product', slug: 'product' },
      },
    ]);
    prisma.teamInvite.count.mockResolvedValue(4);

    const result = await listPendingInvitations(
      {
        orgId: org.id,
        domain: org.domain,
        actorUserId: 'u-owner',
        config: makeConfig(),
      },
      { prisma, now: () => now },
    );

    expect(result).toMatchObject({
      total: 4,
      data: [{ id: 'invite-1', email: 'person@example.com', team: { id: 'team-2' } }],
      permissions: { createInvitation: true, viewPendingInvitations: true },
    });
    expect(prisma.teamInvite.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ OR: expect.anything() }),
      }),
    );
  });

  it('does not query invitations when the actor manages no team', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue(org);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'om-member',
      orgId: org.id,
      userId: 'u-member',
      role: 'member',
    });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'team-2', teamRole: 'member' }]);

    const result = await listPendingInvitations(
      {
        orgId: org.id,
        domain: org.domain,
        actorUserId: 'u-member',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [],
      total: 0,
      permissions: { createInvitation: false, viewPendingInvitations: false },
    });
    expect(prisma.teamInvite.findMany).not.toHaveBeenCalled();
  });
});
