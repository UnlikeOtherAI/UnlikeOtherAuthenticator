import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptTeamInviteWithinTransaction } from '../../src/services/team-invite.service.acceptance.js';
import { makeAcceptanceTx, makeConfig } from '../helpers/team-invite-fixtures.js';

describe('team invite acceptance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a pending invite by creating memberships and marking the invite accepted', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invited@example.com',
      inviteName: 'Invited User',
      teamRole: 'admin',
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      expiresAt: null,
      approvalStatus: 'NOT_REQUIRED',
      org: {
        id: 'org-1',
        domain: 'client.example.com',
      },
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'invited@example.com',
      name: null,
    });
    tx.user.update.mockResolvedValue({
      id: 'user-1',
      name: 'Invited User',
    });
    tx.orgMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'org-member-1' });
    tx.orgMember.count.mockResolvedValue(1);
    tx.orgMember.create.mockResolvedValue({ id: 'org-member-1' });
    tx.teamMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'team-member-1' });
    tx.teamMember.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    tx.teamMember.create.mockResolvedValue({ id: 'team-member-1' });
    tx.teamInvite.update.mockResolvedValue({ id: 'invite-1' });

    const result = await acceptTeamInviteWithinTransaction({
      prisma: tx,
      teamInviteId: 'invite-1',
      userId: 'user-1',
      config: makeConfig(),
      now: new Date('2026-03-02T00:00:00.000Z'),
    });

    expect(result).toEqual({ orgId: 'org-1', teamId: 'team-1' });

    expect(tx.orgMember.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        userId: 'user-1',
        role: 'member',
      },
      select: { id: true },
    });
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-1',
        userId: 'user-1',
        teamRole: 'admin',
      },
      select: { id: true },
    });
    expect(tx.teamInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: {
        acceptedAt: new Date('2026-03-02T00:00:00.000Z'),
        acceptedUserId: 'user-1',
      },
      select: { id: true },
    });
  });

  it('names the one-org-per-origin-domain acceptance conflict', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invited@example.com',
      inviteName: null,
      teamRole: 'member',
      acceptedUserId: null,
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      expiresAt: null,
      approvalStatus: 'NOT_REQUIRED',
      org: { id: 'org-1', domain: 'client.example.com' },
    });
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'invited@example.com',
      name: 'Invited User',
    });
    tx.orgMember.findFirst.mockResolvedValue({ id: 'existing-member', orgId: 'org-other' });

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-1',
        userId: 'user-1',
        config: makeConfig(),
        now: new Date('2026-03-02T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
      message: 'ORG_CONFLICT_ON_DOMAIN',
    });

    expect(tx.orgMember.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).not.toHaveBeenCalled();
    expect(tx.teamInvite.update).not.toHaveBeenCalled();
  });

  it('rejects accepting an expired invite with a generic error', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invited@example.com',
      inviteName: null,
      teamRole: 'member',
      acceptedUserId: null,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      approvalStatus: 'NOT_REQUIRED',
      org: { id: 'org-1', domain: 'client.example.com' },
    });

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-1',
        userId: 'user-1',
        config: makeConfig(),
        now: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.orgMember.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).not.toHaveBeenCalled();
  });

  it('rejects accepting a PENDING (unapproved member-invite) invite with a generic error', async () => {
    const tx = makeAcceptanceTx();
    tx.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-1',
      teamId: 'team-1',
      email: 'invited@example.com',
      inviteName: null,
      teamRole: 'member',
      acceptedUserId: null,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: null,
      approvalStatus: 'PENDING',
      org: { id: 'org-1', domain: 'client.example.com' },
    });

    await expect(
      acceptTeamInviteWithinTransaction({
        prisma: tx,
        teamInviteId: 'invite-1',
        userId: 'user-1',
        config: makeConfig(),
        now: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });

    expect(tx.orgMember.create).not.toHaveBeenCalled();
  });
});
