import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteOrganisation } from '../../src/services/organisation.service.organisation.js';
import { createTestDb } from '../helpers/test-db.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)('admin organisation deletion persistence', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    process.env.DATABASE_URL = handle.databaseUrl;
  });

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (handle) await handle.cleanup();
  });

  it('refuses the legacy bypass and preserves all operational records', async () => {
    const [owner, member] = await Promise.all([
      handle!.prisma.user.create({
        data: { email: 'delete-owner@example.com', userKey: 'delete-owner@example.com' },
      }),
      handle!.prisma.user.create({
        data: { email: 'delete-member@example.com', userKey: 'delete-member@example.com' },
      }),
    ]);
    const organisation = await handle!.prisma.organisation.create({
      data: {
        domain: 'delete.example.com',
        name: 'Delete Me',
        slug: 'delete-me',
        ownerId: owner.id,
      },
    });
    const team = await handle!.prisma.team.create({
      data: {
        orgId: organisation.id,
        name: 'General',
        slug: 'general',
        isDefault: true,
      },
    });
    await handle!.prisma.orgMember.createMany({
      data: [
        { orgId: organisation.id, userId: owner.id, role: 'owner' },
        { orgId: organisation.id, userId: member.id, role: 'member' },
      ],
    });
    await handle!.prisma.teamMember.createMany({
      data: [
        { teamId: team.id, userId: owner.id, teamRole: 'owner' },
        { teamId: team.id, userId: member.id, teamRole: 'member' },
      ],
    });

    await expect(
      deleteOrganisation(
        {
          orgId: organisation.id,
          actor: {
            via: 'admin_superuser',
            userId: 'admin-user',
            email: 'admin@example.com',
          },
        },
        { prisma: handle!.prisma, auditPrisma: handle!.prisma },
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'ENTITY_DELETION_WORKFLOW_REQUIRED' });

    await expect(
      Promise.all([
        handle!.prisma.organisation.count({ where: { id: organisation.id } }),
        handle!.prisma.orgMember.count({ where: { orgId: organisation.id } }),
        handle!.prisma.teamMember.count({ where: { teamId: team.id } }),
        handle!.prisma.user.count({ where: { id: { in: [owner.id, member.id] } } }),
      ]),
    ).resolves.toEqual([1, 2, 2, 2]);

    expect(await handle!.prisma.orgAuditLog.count({ where: { orgId: organisation.id, action: 'org.deleted' } })).toBe(0);
  });

  it('refuses deletion when protected commercial records exist', async () => {
    const owner = await handle!.prisma.user.create({
      data: { email: 'protected-owner@example.com', userKey: 'protected-owner@example.com' },
    });
    const organisation = await handle!.prisma.organisation.create({
      data: {
        domain: 'protected.example.com',
        name: 'Protected Org',
        slug: 'protected-org',
        ownerId: owner.id,
      },
    });
    await handle!.prisma.orgMember.create({
      data: { orgId: organisation.id, userId: owner.id, role: 'owner' },
    });
    await handle!.prisma.billingOrganisationContract.create({
      data: {
        orgId: organisation.id,
        reference: 'protected-contract',
        name: 'Protected Contract',
      },
    });

    await expect(
      deleteOrganisation(
        {
          orgId: organisation.id,
          actor: {
            via: 'admin_superuser',
            userId: 'admin-user',
            email: 'admin@example.com',
          },
        },
        { prisma: handle!.prisma, auditPrisma: handle!.prisma },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'ENTITY_DELETION_WORKFLOW_REQUIRED',
    });

    await expect(
      Promise.all([
        handle!.prisma.organisation.count({ where: { id: organisation.id } }),
        handle!.prisma.orgMember.count({ where: { orgId: organisation.id } }),
        handle!.prisma.billingOrganisationContract.count({
          where: { orgId: organisation.id },
        }),
      ]),
    ).resolves.toEqual([1, 1, 1]);
    await expect(
      handle!.prisma.orgAuditLog.count({
        where: { orgId: organisation.id, action: 'org.deleted' },
      }),
    ).resolves.toBe(0);
  });
});
