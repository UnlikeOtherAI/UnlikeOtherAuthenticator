import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteOrganisation } from '../../src/services/organisation.service.organisation.js';

function makePrismaMock() {
  const prisma = {
    organisation: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    orgMember: {
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked-row' }]),
    $transaction: vi.fn(),
  } as unknown as PrismaClient;

  prisma.$transaction = vi.fn(async (callback: (tx: PrismaClient) => Promise<unknown>) =>
    callback(prisma),
  );

  return prisma;
}

const organisation = {
  id: 'org-1',
  domain: 'acme.example.com',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'u-owner',
  memberInvites: 'allowed',
  iconUrl: null,
  createdAt: new Date('2026-02-15T00:00:00.000Z'),
  updatedAt: new Date('2026-02-15T00:00:00.000Z'),
};

const original = {
  NODE_ENV: process.env.NODE_ENV,
  SHARED_SECRET: process.env.SHARED_SECRET,
  AUTH_SERVICE_IDENTIFIER: process.env.AUTH_SERVICE_IDENTIFIER,
  DATABASE_URL: process.env.DATABASE_URL,
};

function restoreEnv(key: keyof typeof original): void {
  const value = original[key];
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('Organisation service: admin deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
  });

  afterAll(() => {
    restoreEnv('NODE_ENV');
    restoreEnv('SHARED_SECRET');
    restoreEnv('AUTH_SERVICE_IDENTIFIER');
    restoreEnv('DATABASE_URL');
  });

  it('records admin provenance when a superuser deletes in backend-actor mode', async () => {
    const prisma = makePrismaMock();
    const auditPrisma = {
      orgAuditLog: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as Pick<PrismaClient, 'orgAuditLog'>;

    prisma.organisation.findFirst.mockResolvedValue(organisation);
    prisma.organisation.delete.mockResolvedValue({ id: organisation.id });
    prisma.orgMember.findMany.mockResolvedValue([
      { userId: 'u-owner' },
      { userId: 'u-member' },
    ]);

    await expect(
      deleteOrganisation(
        {
          orgId: organisation.id,
          actor: {
            via: 'admin_superuser',
            userId: 'u-admin',
            email: 'admin@example.com',
          },
        },
        { prisma, auditPrisma },
      ),
    ).resolves.toEqual({ deleted: true });

    expect(auditPrisma.orgAuditLog.create).toHaveBeenCalledWith({
      data: {
        orgId: organisation.id,
        actorUserId: null,
        action: 'org.deleted',
        targetType: 'organisation',
        targetId: organisation.id,
        metadata: {
          name: organisation.name,
          slug: organisation.slug,
          ownerId: organisation.ownerId,
          uoa_actor: {
            via: 'admin_superuser',
            user_id: 'u-admin',
            email: 'admin@example.com',
          },
        },
      },
    });
  });

  it('maps a protected-record foreign key refusal to a named public error', async () => {
    const prisma = makePrismaMock();

    prisma.organisation.findFirst.mockResolvedValue(organisation);
    prisma.orgMember.findMany.mockResolvedValue([{ userId: 'u-owner' }]);
    prisma.organisation.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await expect(
      deleteOrganisation(
        {
          orgId: organisation.id,
          actor: {
            via: 'admin_superuser',
            userId: 'u-admin',
            email: 'admin@example.com',
          },
        },
        { prisma },
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
      message: 'ORG_HAS_PROTECTED_RECORDS',
    });
  });
});
