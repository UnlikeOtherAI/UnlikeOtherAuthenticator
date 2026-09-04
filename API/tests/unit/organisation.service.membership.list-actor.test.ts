import { describe, expect, it } from 'vitest';

import { listOrganisationMembers } from '../../src/services/organisation.service.members.js';
import {
  baseOrg,
  makePrismaMock,
  now,
  useOrganisationMembershipTestEnv,
} from './helpers/organisation-service-membership-test-helpers.js';

// Defence-in-depth actor-membership gate on listOrganisationMembers, mirroring the
// getOrganisation coverage in organisation.service.create-update.test.ts. Sibling of
// organisation.service.membership.test.ts; shared mocks/env live in the same helper.
describe('listOrganisationMembers: actor-membership gate (defence in depth)', () => {
  useOrganisationMembershipTestEnv();

  it('refuses to list members when the actor is not an active member of the org', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // Actor membership lookup (activeOnly): no ACTIVE row for this user.
    prisma.orgMember.findFirst.mockResolvedValue(null);

    const promise = listOrganisationMembers(
      { orgId: 'org-1', domain: 'acme.example.com', actorUserId: 'u-stranger' },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(prisma.orgMember.findMany).not.toHaveBeenCalled();
  });

  it('lists members for an actor with an active org membership', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    // Actor membership lookup (activeOnly): ACTIVE row found.
    prisma.orgMember.findFirst.mockResolvedValue({
      id: 'm-actor',
      orgId: 'org-1',
      userId: 'u-actor',
      role: 'member',
    });
    prisma.orgMember.findMany.mockResolvedValue([
      {
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new',
        role: 'member',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        user: { id: 'u-new', name: 'New Member', email: 'new@example.com' },
      },
    ]);
    prisma.orgMember.count.mockResolvedValue(1);

    const result = await listOrganisationMembers(
      { orgId: 'org-1', domain: 'acme.example.com', actorUserId: 'u-actor' },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'member-new', userId: 'u-new', subject: 'u-new', status: 'ACTIVE' }],
      next_cursor: null,
    });
    expect(result.data[0].identity).toEqual({
      displayName: 'New Member',
      avatarImageUrl: expect.any(String),
    });
    expect(result.permissions).toMatchObject({
      addMember: false,
      changeMemberRole: false,
      viewMemberEmail: false,
    });
  });

  it('lists members without an actor membership check in backend mode (no actor supplied)', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(baseOrg);
    prisma.orgMember.findMany.mockResolvedValue([
      {
        id: 'member-new',
        orgId: 'org-1',
        userId: 'u-new',
        role: 'member',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        user: { id: 'u-new', name: 'New Member', email: 'new@example.com' },
      },
    ]);
    prisma.orgMember.count.mockResolvedValue(1);

    const result = await listOrganisationMembers(
      { orgId: 'org-1', domain: 'acme.example.com' },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [{ id: 'member-new', userId: 'u-new' }],
      next_cursor: null,
    });
    expect(result.data[0].identity.email).toBe('new@example.com');
    expect(result.permissions).toMatchObject({
      addMember: true,
      changeMemberRole: true,
      viewMemberEmail: true,
    });
    // No membership to check in backend mode — the caller is the domain.
    expect(prisma.orgMember.findFirst).not.toHaveBeenCalled();
  });
});
