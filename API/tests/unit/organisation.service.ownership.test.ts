import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { transferOrganisationOwnership } from '../../src/services/organisation.service.ownership.js';
import {
  baseOrg,
  makeConfig,
  makePrismaMock,
  now,
  useOrganisationMembershipTestEnv,
} from './helpers/organisation-service-membership-test-helpers.js';

// Ownership transfer, moved here with the service it covers when transferOrganisationOwnership
// left organisation.service.members.ts (CLAUDE.md 500-line limit). The happy-path case below is
// the one from organisation.service.membership.test.ts, unchanged apart from the demotion-role
// assertions the per-domain vocabulary made necessary.

/**
 * The two `orgMember.findFirst` reads a transfer makes, in order: the incoming owner's ACTIVE
 * membership, then the outgoing owner's row inside the transaction.
 */
function stubTransfer(prisma: PrismaClient, options?: { outgoingOwnerRow?: boolean }): void {
  prisma.organisation.findFirst.mockResolvedValue(baseOrg);
  prisma.orgMember.findFirst
    .mockResolvedValueOnce({
      id: 'member-new',
      orgId: 'org-1',
      userId: 'u-new-owner',
      role: 'member',
    })
    .mockResolvedValueOnce(
      options?.outgoingOwnerRow === false
        ? null
        : { id: 'member-old-owner', orgId: 'org-1', userId: 'u-owner', role: 'owner' },
    );
  prisma.organisation.update.mockResolvedValue({ ...baseOrg, ownerId: 'u-new-owner' });
  prisma.orgMember.update.mockResolvedValue({
    id: 'member-new',
    orgId: 'org-1',
    userId: 'u-new-owner',
    role: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  prisma.organisation.findUniqueOrThrow.mockResolvedValue({ ...baseOrg, ownerId: 'u-new-owner' });
}

/** What the transfer wrote to the outgoing owner's membership row, or undefined if it wrote none. */
function demotionWrite(prisma: PrismaClient): unknown {
  return prisma.orgMember.update.mock.calls.find(
    ([arg]) => (arg as { where: { id: string } }).where.id === 'member-old-owner',
  )?.[0];
}

describe('Organisation service: ownership transfer', () => {
  useOrganisationMembershipTestEnv();

  it('transfers ownership to an existing organisation member', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    const result = await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        config: makeConfig(),
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
    // The default vocabulary still contains `admin`, so the write is byte-identical to the
    // pre-vocabulary literal.
    expect(demotionWrite(prisma)).toMatchObject({ data: { role: 'admin' } });
  });

  it('demotes into `admin` wherever the vocabulary contains it, whatever its position', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        config: makeConfig({ org_roles: ['owner', 'member', 'admin'] }),
      },
      { prisma },
    );

    expect(demotionWrite(prisma)).toMatchObject({ data: { role: 'admin' } });
  });

  it('demotes into the first non-owner role when the vocabulary has no `admin`', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        config: makeConfig({ org_roles: ['owner', 'registrar', 'member'] }),
      },
      { prisma },
    );

    // Never `admin`: a role outside the domain's own vocabulary is unmentionable by role_grants
    // and rejected by ensureOrgRole on every later write.
    expect(demotionWrite(prisma)).toMatchObject({ data: { role: 'registrar' } });
  });

  it('demotes into the role the caller named', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        previousOwnerRole: 'member',
        config: makeConfig({ org_roles: ['owner', 'registrar', 'member'] }),
      },
      { prisma },
    );

    expect(demotionWrite(prisma)).toMatchObject({ data: { role: 'member' } });
  });

  it('refuses a demotion role outside the domain vocabulary, before any write', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    const promise = transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        previousOwnerRole: 'admin',
        config: makeConfig({ org_roles: ['owner', 'registrar', 'member'] }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.organisation.update).not.toHaveBeenCalled();
    expect(prisma.orgMember.update).not.toHaveBeenCalled();
  });

  it('refuses `owner` as the demotion role — a transfer that does not transfer', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    const promise = transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        previousOwnerRole: 'owner',
        config: makeConfig(),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.organisation.update).not.toHaveBeenCalled();
  });

  it('refuses the transfer when the vocabulary has no non-owner role at all', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma);

    const promise = transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        config: makeConfig({ org_roles: ['owner'] }),
      },
      { prisma },
    );

    // Fails closed rather than leaving `ownerId` moved and the outgoing owner holding `owner`.
    await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    expect(prisma.organisation.update).not.toHaveBeenCalled();
  });

  it('transfers without a demotion write when the outgoing owner has no membership row', async () => {
    const prisma = makePrismaMock();
    stubTransfer(prisma, { outgoingOwnerRow: false });

    const result = await transferOrganisationOwnership(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        newOwnerId: 'u-new-owner',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(result).toMatchObject({ ownerId: 'u-new-owner' });
    expect(demotionWrite(prisma)).toBeUndefined();
  });
});
