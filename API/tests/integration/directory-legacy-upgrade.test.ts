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

    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: apiRoot, env: { ...process.env, DATABASE_URL: handle.databaseUrl }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const applied = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(applied[0].count).toBe(206n);
    expect(await db.user.findUniqueOrThrow({ where: { id: person.id } })).toMatchObject({ name: 'Legacy Name', email: 'upgrade@example.com', pronounsPreset: null, pronounsCustom: null });
    expect(Buffer.from((await db.userAvatar.findUniqueOrThrow({ where: { userId: person.id } })).data).equals(bytes)).toBe(true);
    expect(await db.orgMember.count({ where: { orgId: org.id, userId: person.id } })).toBe(1);
    expect(await db.historicalIdentityReference.count()).toBe(1);
    expect(await db.historicalOrganisationIdentityReference.count()).toBe(0);
    expect(await db.directoryChangeOutbox.count()).toBe(0);
    expect(await db.directoryOrganisationRevision.count()).toBe(0);
    expect(await db.directoryCredential.count()).toBe(0);
    await expect(db.user.update({ where: { id: person.id }, data: { pronounsPreset: 'custom', pronounsCustom: null } })).rejects.toThrow();
    await withDirectoryMutation(db, [{ orgId: org.id, kind: 'profile.changed', subjectId: person.id }], tx =>
      tx.user.update({ where: { id: person.id }, data: { name: 'Current Name' } }));
    expect(await db.directoryChangeOutbox.findMany({ select: { orgId: true, subjectId: true, revision: true } }))
      .toEqual([{ orgId: org.id, subjectId: person.id, revision: 1n }]);
    passed = true;
  });
});
