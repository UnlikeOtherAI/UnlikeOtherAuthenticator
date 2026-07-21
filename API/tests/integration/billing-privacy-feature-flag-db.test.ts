import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';

type TestDb = NonNullable<Awaited<ReturnType<typeof createTestDb>>>;

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260721183000_normalize_deepwater_privacy_flag/migration.sql',
  ),
  'utf8',
);

describe.skipIf(!process.env.DATABASE_URL)('DeepWater privacy flag migration', () => {
  let db: TestDb;

  beforeAll(async () => {
    const created = await createTestDb();
    if (!created) throw new Error('DATABASE_URL_REQUIRED');
    db = created;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('normalizes the ungranted legacy flag and rejects an override', async () => {
    const owner = await db.prisma.user.create({
      data: {
        email: 'privacy-owner@example.com',
        userKey: 'privacy-owner@example.com',
        name: 'Privacy Owner',
      },
    });
    const org = await db.prisma.organisation.create({
      data: {
        domain: 'privacy.example',
        name: 'Privacy Test',
        slug: 'privacy-test',
        ownerId: owner.id,
      },
    });
    const app = await db.prisma.app.create({
      data: {
        orgId: org.id,
        name: 'DeepWater API',
        identifier: 'deepwater-api',
        platform: 'web',
        featureFlagsEnabled: true,
      },
    });
    await db.prisma.featureFlagDefinition.create({
      data: {
        appId: app.id,
        key: 'can_be_private',
        description: 'Allow this UOA user to create private DeepWater research.',
        defaultState: false,
      },
    });

    await db.prisma.$executeRawUnsafe(migration);
    await expect(
      db.prisma.featureFlagDefinition.findUniqueOrThrow({
        where: { appId_key: { appId: app.id, key: 'can_be_private' } },
      }),
    ).resolves.toMatchObject({
      description: 'Allows paid private DeepWater research for an entitled team.',
      defaultState: false,
    });

    await db.prisma.featureFlagDefinition.update({
      where: { appId_key: { appId: app.id, key: 'can_be_private' } },
      data: { description: 'Allow this UOA user to create private DeepWater research.' },
    });
    await db.prisma.featureFlagRoleValue.create({
      data: {
        appId: app.id,
        flagKey: 'can_be_private',
        roleName: 'member',
        value: true,
      },
    });

    await expect(db.prisma.$executeRawUnsafe(migration)).rejects.toThrow(
      /DEEPWATER_PRIVACY_LEGACY_OVERRIDES_PRESENT/,
    );
  });
});
