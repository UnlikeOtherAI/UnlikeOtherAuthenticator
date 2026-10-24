import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { createOrganisation, updateOrganisation } from '../../src/services/organisation.service.organisation.js';
import { makeConfig, makePrismaMock, now, useOrganisationCrudEnv } from './helpers/organisation-crud-fixtures.js';

function conflict(modelName: string, target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('concurrent allocation', {
    code: 'P2002', clientVersion: 'test', meta: { modelName, target },
  });
}

describe('chosen organisation address race at the service write boundary', () => {
  useOrganisationCrudEnv();

  it.each([undefined, 'chosen-address'])('maps a create race after the global availability probe: %s', async slug => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: 'owner' });
    prisma.organisation.create.mockRejectedValue(conflict('Organisation', ['slug']));
    await expect(createOrganisation({ domain: 'other.example.com', name: 'Acme', slug,
      ownerId: 'owner', actorUserId: 'owner', config: makeConfig() }, { prisma }))
      .rejects.toMatchObject({ statusCode: 400, message: 'ORG_SLUG_TAKEN' });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({ values: [slug ?? 'acme'] }));
    expect(prisma.organisation.create).toHaveBeenCalledTimes(1);
    expect(prisma.team.create).not.toHaveBeenCalled();
    expect(prisma.orgMember.create).not.toHaveBeenCalled();
  });

  it('maps an explicit rename race without retrying with another address', async () => {
    const prisma = makePrismaMock();
    prisma.organisation.findFirst.mockResolvedValue({ id: 'org-1', domain: 'source.example.com',
      name: 'Original', slug: 'original', ownerId: 'owner', createdAt: now, updatedAt: now });
    prisma.orgMember.findFirst.mockResolvedValue({ id: 'membership', role: 'owner' });
    prisma.organisation.update.mockRejectedValue(conflict('Organisation', ['slug']));
    await expect(updateOrganisation({ orgId: 'org-1', domain: 'other.example.com', name: 'Acme',
      slug: 'acme', actorUserId: 'owner', config: makeConfig() }, { prisma }))
      .rejects.toMatchObject({ statusCode: 400, message: 'ORG_SLUG_TAKEN' });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({ values: ['acme'] }));
    expect(prisma.organisation.update).toHaveBeenCalledTimes(1);
  });

  it('preserves an unrelated organisation write error', async () => {
    const prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: 'owner' });
    const error = conflict('Organisation', ['owner_id']);
    prisma.organisation.create.mockRejectedValue(error);
    await expect(createOrganisation({ domain: 'other.example.com', name: 'Acme',
      ownerId: 'owner', actorUserId: 'owner', config: makeConfig() }, { prisma })).rejects.toBe(error);
  });
});
