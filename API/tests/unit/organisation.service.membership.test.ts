import { describe, expect, it, vi } from 'vitest';

import {
  addOrganisationMember,
  changeOrganisationMemberRole,
  listOrganisationMembers,
  removeOrganisationMember,
  transferOrganisationOwnership,
} from '../../src/services/organisation.service.members.js';
import {
  baseOrg,
  makeConfig,
  makePrismaMock,
  now,
  useOrganisationMembershipTestEnv,
} from './helpers/organisation-service-membership-test-helpers.js';

// CLAUDE.md 500-line split of the original organisation.service.membership.test.ts: member
// add/list/role-change/remove/ownership-transfer. Deactivate/reactivate lifecycle lives in
// organisation.service.membership.lifecycle.test.ts; the activeOnly actor-authorization filter
// lives in organisation.service.membership.active-only.test.ts. Shared mocks/config/env setup
// live in tests/unit/helpers/organisation-service-membership-test-helpers.ts. Only the location
// changed — no assertion here was altered from the pre-split file.
describe('Organisation service: membership', () => {
  useOrganisationMembershipTestEnv();

  it('lists organisation members with cursor pagination', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findMany.mockResolvedValue([
      {
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'member-old',
        orgId: 'org-1',
        userId: 'u-old',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await listOrganisationMembers(
      { orgId: 'org-1', domain: 'acme.example.com', limit: 1 },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'member-new', userId: 'u-new' }],
      next_cursor: 'member-old',
    });
  });

  it('adds a new organisation member and assigns the default team', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // First call: actor membership lookup (owner).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-new', domain: null });
    prisma.orgMember.create.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new',
      role: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-default' });
    prisma.teamMember.create.mockResolvedValue({ id: 'tm-new' });

    const member = await addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-new',
        role: 'member',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(member).toMatchObject({ id: 'member-new', userId: 'u-new', role: 'member' });
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { teamId: 'team-default', userId: 'u-new' } }),
    );
  });

  it('rejects adding a member when the actor is not owner or admin', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValueOnce({
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-actor',
      role: 'member',
    });

    const promise = addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-actor',
        userId: 'u-new',
        role: 'member',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
  });

  it('changes a member role when called by the owner', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'member-target',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'member',
    });
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-target',
      orgId: 'org-1',
      userId: 'u-member',
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });

    const result = await changeOrganisationMemberRole(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
        role: 'admin',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({ id: 'member-target', role: 'admin' });
  });

  it('removes a member (soft-remove), cascades team/group memberships, and revokes domain sessions', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // actor lookup (owner), then target lookup (member).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce({
        id: 'member-target',
        orgId: 'org-1',
        userId: 'u-member',
        role: 'member',
      });
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.update.mockResolvedValue({ id: 'member-target', status: 'REMOVED' });
    prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });
    prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

    const revokeRefreshTokensForUserDomain = vi.fn().mockResolvedValue({ revokedCount: 2 });

    await removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma, revokeRefreshTokensForUserDomain },
    );

    expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', team: { orgId: 'org-1' }, status: { not: 'REMOVED' } },
      data: { status: 'REMOVED', statusChangedAt: expect.any(Date) },
    });
    expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u-member', group: { orgId: 'org-1' } },
    });
    expect(prisma.orgMember.delete).not.toHaveBeenCalled();
    expect(prisma.orgMember.update).toHaveBeenCalledWith({
      where: { id: 'member-target' },
      data: { status: 'REMOVED', statusChangedAt: expect.any(Date) },
    });
    // Domain-scoped revocation must NOT bump the global user token version — it must only ever
    // call the scoped revoke function, never touch prisma.user.update directly.
    expect(revokeRefreshTokensForUserDomain).toHaveBeenCalledWith('u-member', 'acme.example.com');
  });

  it('does not let a removal failure occur when session revocation throws (best-effort)', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce({ id: 'member-target', orgId: 'org-1', userId: 'u-member', role: 'member' });
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.orgMember.update.mockResolvedValue({ id: 'member-target', status: 'REMOVED' });
    prisma.teamMember.updateMany.mockResolvedValue({ count: 1 });
    prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

    const revokeRefreshTokensForUserDomain = vi.fn().mockRejectedValue(new Error('unreachable admin db'));

    const result = await removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-member',
      },
      { prisma, revokeRefreshTokensForUserDomain },
    );

    expect(result).toEqual({ removed: true });
  });

  it('prevents removing the sole organisation owner', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      })
      .mockResolvedValueOnce({
        id: 'm-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      });
    prisma.orgMember.count.mockResolvedValue(1);

    const promise = removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.orgMember.delete).not.toHaveBeenCalled();
  });

  it('transfers ownership to an existing organisation member', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new-owner',
        role: 'member',
      })
      .mockResolvedValueOnce({
        id: 'member-old-owner',
        orgId: 'org-1',
        userId: 'u-owner',
        role: 'owner',
      });
    prisma.organisation.update.mockResolvedValue({
      ...baseOrg,
      ownerId: 'u-new-owner',
    });
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.organisation.findUniqueOrThrow.mockResolvedValue({
      ...baseOrg,
      ownerId: 'u-new-owner',
    });

    const result = await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
      },
      { prisma },
    );

    expect(result).toMatchObject({ id: 'org-1', ownerId: 'u-new-owner' });
    expect(prisma.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org-1' },
        data: { ownerId: 'u-new-owner' },
      }),
    );
  });

  it('refuses an admin actor from adding a new owner member (no self-elevation)', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findFirst.mockResolvedValueOnce({
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-admin',
      role: 'admin',
    });

    const promise = addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-admin',
        userId: 'u-new',
        role: 'owner',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
  });

  it('refuses an admin actor from removing an owner member even when other owners remain', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // actor lookup (admin), then target lookup (another owner).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({
        id: 'm-admin',
        orgId: 'org-1',
        userId: 'u-admin',
        role: 'admin',
      })
      .mockResolvedValueOnce({
        id: 'm-other-owner',
        orgId: 'org-1',
        userId: 'u-other-owner',
        role: 'owner',
      });
    // ownerCount = 2 so the ownerCount<=1 guard would otherwise let the delete proceed.
    prisma.orgMember.count.mockResolvedValue(2);

    const promise = removeOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-admin',
        userId: 'u-other-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.delete).not.toHaveBeenCalled();
  });

  it('reactivates a previously removed member instead of rejecting "already a member"', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // Actor membership lookup (owner), then the tx's existingMemberInOrg lookup (REMOVED row),
    // then the domain-wide ACTIVE-only check (none).
    prisma.orgMember.findFirst
      .mockResolvedValueOnce({ id: 'm-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' })
      .mockResolvedValueOnce({ id: 'member-old', status: 'REMOVED' })
      .mockResolvedValueOnce(null);
    prisma.orgMember.count.mockResolvedValue(1);
    prisma.user.findUnique.mockResolvedValue({ id: 'u-old', domain: null });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-default' });
    prisma.teamMember.findFirst.mockResolvedValue(null);
    prisma.orgMember.update.mockResolvedValue({
      id: 'member-old',
      orgId: 'org-1',
      userId: 'u-old',
      role: 'member',
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    const member = await addOrganisationMember(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-old',
        role: 'member',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(member).toMatchObject({ id: 'member-old', userId: 'u-old', role: 'member', status: 'ACTIVE' });
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
    expect(prisma.orgMember.update).toHaveBeenCalledWith({
      where: { id: 'member-old' },
      data: { role: 'member', status: 'ACTIVE', statusChangedAt: expect.any(Date) },
      select: expect.any(Object),
    });
    // No existing default-team row was found, so it creates one rather than updating.
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: { teamId: 'team-default', userId: 'u-old' },
    });
  });
});
