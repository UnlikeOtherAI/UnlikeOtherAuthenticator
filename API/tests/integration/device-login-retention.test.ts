import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { getEnv } from '../../src/config/env.js';
import { runInTransaction } from '../../src/db/tenant-context.js';
import { pruneExpiredSecurityData } from '../../src/services/retention-pruning.service.js';
import { previewEntityDeletion } from '../../src/services/entity-deletion-preview.service.js';
import { eraseOperationalIdentity, sweepDeletion } from '../../src/services/entity-deletion-sweep.service.js';

const domain = 'device-retention.example.com';

describe.skipIf(!process.env.DATABASE_URL)('device-login retention and identity deletion', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  const original = process.env.DATABASE_URL;
  beforeAll(async () => {
    const db = await createTestDb();
    if (!db) throw new Error('Database required');
    handle = db;
    process.env.DATABASE_URL = db.databaseUrl;
  });
  afterAll(async () => {
    if (original === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env.DATABASE_URL = original;
    await handle?.cleanup();
  });
  beforeEach(async () => {
    await handle.prisma.deviceLoginGrant.deleteMany();
    await handle.prisma.deviceLoginAttemptBucket.deleteMany();
  });
  const user = () => handle.prisma.user.create({ data: {
    email: randomUUID() + '@example.com', userKey: randomUUID(),
  } });
  const grant = (userId: string, data: Partial<Prisma.DeviceLoginGrantUncheckedCreateInput> = {}) =>
    handle.prisma.deviceLoginGrant.create({ data: {
      codeHash: randomUUID(), sourceFamilyId: randomUUID(), userId, tokenVersion: 0,
      domain, clientId: 'device-retention-client', configUrl: 'https://' + domain + '/config',
      expiresAt: new Date(Date.now() + 300_000), ...data,
    } });
  async function container() {
    const org = await handle.prisma.organisation.create({ data: {
      domain, name: 'Device retention', slug: randomUUID(),
    } });
    const first = await handle.prisma.team.create({ data: {
      orgId: org.id, name: 'First', slug: randomUUID(), isDefault: true,
    } });
    const second = await handle.prisma.team.create({ data: {
      orgId: org.id, name: 'Second', slug: randomUUID(),
    } });
    return { org, first, second };
  }
  it('expires buckets and old grants while retaining active codes and recent issuance history', async () => {
    const person = await user(), now = new Date();
    const expired = new Date(now.getTime() - 1), active = new Date(now.getTime() + 1);
    const recent = await grant(person.id, { expiresAt: expired, createdAt: new Date(now.getTime() - 600_000) });
    const used = await grant(person.id, { expiresAt: expired, usedAt: expired,
      createdAt: new Date(now.getTime() - 1_200_000) });
    const unexpired = await grant(person.id, { expiresAt: active, createdAt: new Date(now.getTime() - 3_600_000) });
    await grant(person.id, { expiresAt: expired, createdAt: new Date(now.getTime() - 1_800_001) });
    await grant(person.id, { expiresAt: now, createdAt: new Date(now.getTime() - 1_800_000) });
    await handle.prisma.deviceLoginAttemptBucket.createMany({ data: [
      { keyHash: 'expired', count: 9, resetAt: expired },
      { keyHash: 'boundary', count: 9, resetAt: now },
      { keyHash: 'active', count: 7, resetAt: active },
    ] });
    const result = await pruneExpiredSecurityData({ env: getEnv(), prisma: handle.prisma, now: () => now });
    expect(result.deviceLoginGrantsDeleted).toBe(2);
    expect(result.deviceLoginAttemptBucketsDeleted).toBe(2);
    expect((await handle.prisma.deviceLoginGrant.findMany()).map(row => row.id).sort())
      .toEqual([recent.id, used.id, unexpired.id].sort());
    expect(await handle.prisma.deviceLoginAttemptBucket.findMany()).toEqual([
      { keyHash: 'active', count: 7, resetAt: active },
    ]);
  });
  it.each(['RETAIN_REFERENCE', 'ERASE_REFERENCE'] as const)('erases a person’s grants in %s mode', async (mode) => {
    const target = await user(), other = await user();
    await grant(target.id);
    const survivor = await grant(other.id);
    await runInTransaction(handle.prisma, tx => eraseOperationalIdentity(tx, target.id, mode));
    expect(await handle.prisma.deviceLoginGrant.findMany()).toMatchObject([{ id: survivor.id, userId: other.id }]);
    const identity = await handle.prisma.user.findUnique({ where: { id: target.id } });
    if (mode === 'RETAIN_REFERENCE') expect(identity?.lifecycleStatus).toBe('DELETED');
    else expect(identity).toBeNull();
  });
  it('removes only grants for the deleted team while retaining the shared person and sibling grants', async () => {
    const person = await user(), { org, first, second } = await container();
    await grant(person.id, { orgId: org.id, teamId: first.id });
    const sibling = await grant(person.id, { orgId: org.id, teamId: second.id });
    const standalone = await grant(person.id);
    const preview = await previewEntityDeletion(handle.prisma, 'TEAM', first.id, 'RETAIN_REFERENCE');
    await runInTransaction(handle.prisma, tx => sweepDeletion(tx, preview));
    expect((await handle.prisma.deviceLoginGrant.findMany()).map(row => row.id).sort())
      .toEqual([sibling.id, standalone.id].sort());
    expect(await handle.prisma.team.findUnique({ where: { id: first.id } })).toBeNull();
    expect((await handle.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).lifecycleStatus).toBe('ACTIVE');
  });
  it('removes organisation grants, including rows without a team, while retaining unrelated grants', async () => {
    const person = await user(), { org, first, second } = await container();
    await grant(person.id, { orgId: org.id, teamId: first.id });
    await grant(person.id, { orgId: org.id, teamId: second.id });
    await grant(person.id, { orgId: org.id });
    const survivor = await grant(person.id);
    const preview = await previewEntityDeletion(handle.prisma, 'ORGANISATION', org.id, 'RETAIN_REFERENCE');
    await runInTransaction(handle.prisma, tx => sweepDeletion(tx, preview));
    expect(await handle.prisma.deviceLoginGrant.findMany()).toMatchObject([{ id: survivor.id }]);
    expect(await handle.prisma.organisation.findUnique({ where: { id: org.id } })).toBeNull();
  });
});
