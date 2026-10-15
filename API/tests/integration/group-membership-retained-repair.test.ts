import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const schema = process.env.UOA_AUDIT_GROUP_REPAIR_SCHEMA;
describe.skipIf(!process.env.DATABASE_URL || !schema)('retained group admission data repair', () => {
  let db: PrismaClient, url: string;
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55460' || target.pathname !== '/uoa_api_audit' ||
      !/^test_\d+_[a-f0-9]{32}$/.test(schema!)) throw new Error('Repair proof requires the explicit owned audit database/schema');
    target.searchParams.set('schema', schema!);
    url = target.toString();
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$connect();
  });
  afterAll(async () => { await db?.$disconnect(); });

  it('applies the forward migration to the original failed grants and retains repair events', async () => {
    const invalid = await db.$queryRaw<Array<{ id: string; orgId: string; userId: string }>>`
      SELECT gm.id,g.org_id AS "orgId",gm.user_id AS "userId" FROM group_members gm JOIN groups g ON g.id=gm.group_id
      WHERE NOT EXISTS(SELECT 1 FROM org_members om WHERE om.org_id=g.org_id AND om.user_id=gm.user_id AND om.status<>'REMOVED')`;
    expect(invalid.length).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const row of invalid) counts.set(row.orgId, await db.directoryChangeOutbox.count({ where: { orgId: row.orgId } }));
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    expect(await db.groupMember.count({ where: { id: { in: invalid.map(row => row.id) } } })).toBe(0);
    for (const row of invalid) {
      expect(await db.directoryChangeOutbox.findUniqueOrThrow({ where: { id: 'group-repair:' + row.id } }))
        .toMatchObject({ orgId: row.orgId, subjectId: row.userId, kind: 'membership.changed' });
      expect((await db.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: row.orgId, userId: row.userId } } })).status).toBe('REMOVED');
    }
    for (const [orgId, count] of counts) {
      expect(await db.directoryChangeOutbox.count({ where: { orgId } })).toBe(count + invalid.filter(row => row.orgId === orgId).length);
    }
    // A second normal deploy is idempotent; the repair does not repeat effects.
    const before = await db.directoryChangeOutbox.count();
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    expect(await db.directoryChangeOutbox.count()).toBe(before);
    console.info(`Repaired ${invalid.length} retained invalid group grant(s) through normal forward migration; evidence retained`);
  });
});
