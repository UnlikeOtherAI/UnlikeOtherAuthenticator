import { describe, expect, it, vi } from 'vitest';

import {
  deactivateOrganisationMember,
  reactivateOrganisationMember,
} from '../../src/services/organisation.service.lifecycle.js';
import {
  baseOrg,
  makePrismaMock,
  useOrganisationMembershipLifecycleTestEnv,
} from './helpers/organisation-service-membership-test-helpers.js';

// CLAUDE.md 500-line split of the original organisation.service.membership.test.ts:
// deactivate/reactivate lifecycle. See organisation.service.membership.test.ts (add/list/
// role-change/remove/ownership-transfer) and organisation.service.membership.active-only.test.ts
// (activeOnly filter) for the rest. Only the location changed — no assertion here was altered
// from the pre-split file.
describe('Organisation service: member lifecycle (deactivate/reactivate)', () => {
  useOrganisationMembershipLifecycleTestEnv();

  it('deactivates an ACTIVE member, cascades team rows, and revokes domain sessions', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // Actor lookup (owner), then target member lookup (ACTIVE member).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce({ id: 'member-target', role: 'member' });
    prisma.orgMember.update.mockResolvedValue({ id: 'member-target', status: 'DEACTIVATED' });
    prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });

    const revokeRefreshTokensForUserDomain = vi.fn().mockResolvedValue({ revokedCount: 1 });

    const result = await deactivateOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma, revokeRefreshTokensForUserDomain },
    );

    expect(result).toEqual({ deactivated: true });
    expect(prisma.orgMember.update).toHaveBeenCalledWith({
      where: { id: 'member-target' },
      data: { status: 'DEACTIVATED', statusChangedAt: expect.any(Date) },
    });
    expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', team: { orgId: 'org-1' }, status: 'ACTIVE' },
      data: { status: 'DEACTIVATED', statusChangedAt: expect.any(Date) },
    });
    expect(revokeRefreshTokensForUserDomain).toHaveBeenCalledWith('u-member', 'acme.example.com');
  });

  it('rejects deactivating an owner', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce({ id: 'member-owner', role: 'owner' });

    const revokeRefreshTokensForUserDomain = vi.fn();

    const promise = deactivateOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-owner-2',
      },
      { prisma, revokeRefreshTokensForUserDomain },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.orgMember.update).not.toHaveBeenCalled();
    expect(revokeRefreshTokensForUserDomain).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the target member is not ACTIVE', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce(null);

    const promise = deactivateOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('reactivates a DEACTIVATED member without touching sessions', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce({ id: 'member-target' });
    prisma.orgMember.update.mockResolvedValue({ id: 'member-target', status: 'ACTIVE' });
    prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });

    const result = await reactivateOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma },
    );

    expect(result).toEqual({ reactivated: true });
    expect(prisma.orgMember.update).toHaveBeenCalledWith({
      where: { id: 'member-target' },
      data: { status: 'ACTIVE', statusChangedAt: expect.any(Date) },
    });
    expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', team: { orgId: 'org-1' }, status: 'DEACTIVATED' },
      data: { status: 'ACTIVE', statusChangedAt: expect.any(Date) },
    });
  });
});
