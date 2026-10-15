import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/test-db.js';
import { withDirectoryMutation } from '../../src/services/directory-mutation.service.js';

const apiRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const baseline = 'a8daff44'; // Last reviewed schema before the six authority migrations.

describe.skipIf(!process.env.DATABASE_URL)('legacy authority schema upgrade on PostgreSQL', () => {
  let temporary: string;
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>;
  let passed = false;

  beforeAll(async () => {
    temporary = await mkdtemp(path.join(apiRoot, '.audit-upgrade-'));
    const archive = execFileSync('git', ['archive', baseline, 'API/prisma'], {
      cwd: path.dirname(apiRoot), maxBuffer: 4 * 1024 * 1024,
    });
    execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive });
    handle = (await createTestDb({ migrationSchema: path.join(temporary, 'API/prisma/schema.prisma') }))!;
  });

  afterAll(async () => {
    if (handle) {
      if (passed) await handle.cleanup();
      else {
        await handle.prisma.$disconnect();
        console.info(`Retained failed upgrade schema: ${handle.schema}`);
      }
    }
    // Only remove this test's generated source archive, never a database record.
    if (temporary && path.dirname(temporary) === apiRoot && path.basename(temporary).startsWith('.audit-upgrade-')) {
      await rm(temporary, { recursive: true });
    }
  });

  it('preserves legacy canonical data without inventing historical orgs or outbox revisions', async () => {
    const db = handle.prisma;
    const old = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(old[0].count).toBe(200n);
    const person = await db.user.create({ data: { email: 'upgrade@example.com', userKey: 'upgrade@example.com', name: 'Legacy Name' }, select: { id: true } });
    const org = await db.organisation.create({ data: { domain: 'upgrade.example.com', name: 'Legacy Org', slug: 'legacy', ownerId: person.id }, select: { id: true } });
    await db.orgMember.create({ data: { orgId: org.id, userId: person.id, role: 'owner' }, select: { id: true } });
    await db.historicalIdentityReference.create({ data: { userId: person.id, domain: 'upgrade.example.com' } });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await db.userAvatar.create({ data: { userId: person.id, contentType: 'image/png', data: bytes, sizeBytes: bytes.length }, select: { id: true } });
    const owner = await db.user.create({ data: { email: 'repair-owner@example.com', userKey: 'repair-owner' }, select: { id: true } });
    const removed = await db.user.create({ data: { email: 'repair-removed@example.com', userKey: 'repair-removed' }, select: { id: true } });
    const orphan = await db.user.create({ data: { email: 'repair-orphan@example.com', userKey: 'repair-orphan' }, select: { id: true } });
    const inactive = await db.user.create({ data: { email: 'repair-inactive@example.com', userKey: 'repair-inactive' }, select: { id: true } });
    const repairOrg = await db.organisation.create({ data: { domain: 'upgrade.example.com', name: 'Repair', slug: 'repair', ownerId: owner.id }, select: { id: true } });
    await db.orgMember.createMany({ data: [
      { orgId: repairOrg.id, userId: owner.id, role: 'owner' },
      { orgId: repairOrg.id, userId: removed.id, status: 'REMOVED' },
      { orgId: repairOrg.id, userId: inactive.id, status: 'DEACTIVATED' },
    ] });
    const group = await db.group.create({ data: { orgId: repairOrg.id, name: 'Legacy group' } });
    await db.groupMember.createMany({ data: [removed.id, orphan.id, inactive.id].map(userId => ({ groupId: group.id, userId, isAdmin: true })) });

    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: apiRoot, env: { ...process.env, DATABASE_URL: handle.databaseUrl }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const applied = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(applied[0].count).toBe(207n);
    expect(await db.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({ name: 'Legacy Name', email: 'upgrade@example.com', pronounsPreset: null, pronounsCustom: null });
    expect(Buffer.from((await db.userAvatar.findUniqueOrThrow({ where: { userId: person.id } })).data).equals(bytes)).toBe(true);
    expect(await db.orgMember.count({ where: { orgId: org.id, userId: person.id } })).toBe(1);
    expect(await db.historicalIdentityReference.count()).toBe(1);
    expect(await db.historicalOrganisationIdentityReference.count()).toBe(0);
    expect(await db.directoryChangeOutbox.count({ where: { orgId: org.id } })).toBe(0);
    expect(await db.directoryOrganisationRevision.count({ where: { orgId: org.id } })).toBe(0);
    expect(await db.groupMember.findMany({ where: { groupId: group.id }, select: { userId: true, isAdmin: true } }))
      .toEqual([{ userId: inactive.id, isAdmin: true }]);
    const repaired = await db.directoryChangeOutbox.findMany({ where: { orgId: repairOrg.id }, orderBy: { revision: 'asc' } });
    expect(repaired.map(row => row.revision)).toEqual([1n, 2n]);
    expect(repaired.every(row => row.kind === 'membership.changed' && row.id.startsWith('group-repair:'))).toBe(true);
    expect(repaired.map(row => row.subjectId).sort()).toEqual([removed.id, orphan.id].sort());
    expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: repairOrg.id, userId: removed.id } } })).status).toBe('REMOVED');
    // An older writer issuing its original INSERT cannot recreate repaired grants.
    await expect(db.groupMember.create({ data: { groupId: group.id, userId: removed.id } })).rejects.toThrow();
    await expect(db.groupMember.create({ data: { groupId: group.id, userId: orphan.id } })).rejects.toThrow();
    expect(await db.directoryChangeOutbox.count({ where: { orgId: repairOrg.id } })).toBe(2);
    expect(await db.directoryCredential.count()).toBe(0);
    await expect(db.user.update({ where: { id: person.id }, data: { pronounsPreset: 'custom', pronounsCustom: null } })).rejects.toThrow();
    await withDirectoryMutation(db, [{ orgId: org.id, kind: 'profile.changed', subjectId: person.id }], tx =>
      tx.user.update({ where: { id: person.id }, data: { name: 'Current Name' } }));
    expect(await db.directoryChangeOutbox.findMany({ where: { orgId: org.id }, select: { orgId: true, subjectId: true, revision: true } }))
      .toEqual([{ orgId: org.id, subjectId: person.id, revision: 1n }]);
    passed = true;
  });
});
