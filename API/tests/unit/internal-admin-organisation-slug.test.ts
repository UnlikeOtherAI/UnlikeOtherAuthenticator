import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  user: { findFirst: vi.fn() },
  organisation: { create: vi.fn() },
  team: { create: vi.fn() },
}));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => prisma, getPrisma: () => prisma }));

import { createAdminOrganisation } from '../../src/services/internal-admin.service.organisations.js';

describe('internal admin organisation address admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma));
    prisma.user.findFirst.mockResolvedValue({ id: 'owner' });
    prisma.$queryRaw.mockResolvedValue([{ taken: false }]);
  });

  const input = { domain: 'other.example.com', name: 'Acme', ownerEmail: 'owner@example.test' };

  it('uses global occupancy before writing the organisation', async () => {
    prisma.$queryRaw.mockResolvedValue([{ taken: true }]);
    await expect(createAdminOrganisation(input)).rejects.toMatchObject({ statusCode: 400, message: 'ORG_SLUG_TAKEN' });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({ values: ['acme'] }));
    expect(prisma.organisation.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent claim after availability to the same refusal', async () => {
    prisma.organisation.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('concurrent claim', {
      code: 'P2002', clientVersion: 'test',
      meta: { modelName: 'Organisation', target: 'organisations_slug_admission_key' },
    }));
    await expect(createAdminOrganisation(input)).rejects.toMatchObject({ statusCode: 400, message: 'ORG_SLUG_TAKEN' });
    expect(prisma.organisation.create).toHaveBeenCalledTimes(1);
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it('preserves unrelated database failures', async () => {
    const error = new Error('database disconnected');
    prisma.organisation.create.mockRejectedValue(error);
    await expect(createAdminOrganisation(input)).rejects.toBe(error);
    expect(prisma.organisation.create).toHaveBeenCalledTimes(1);
  });
});
