import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '../../src/db/prisma.js';
import { setEntityLifecycle } from '../../src/services/internal-admin-lifecycle.service.js';

const schema = process.env.UOA_AUDIT_ACCESS_RECOVERY_SCHEMA;
describe.skipIf(!schema)('retained access-policy deadlock normal lifecycle retry', () => {
  let db: PrismaClient;
  const saved = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL,
    ADMIN_AUTH_DOMAIN: process.env.ADMIN_AUTH_DOMAIN };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '55460' || url.pathname !== '/uoa_api_audit' ||
      !/^test_\d+_[a-f0-9]{32}$/.test(schema!)) throw new Error('Recovery requires the owned audit database/schema');
    url.searchParams.set('schema', schema!);
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    url.username = 'uoa_app';
    process.env.DATABASE_URL = url.toString();
    url.username = 'uoa_admin';
    process.env.DATABASE_ADMIN_URL = url.toString();
    process.env.ADMIN_AUTH_DOMAIN = 'admin.example.com';
    await disconnectPrisma();
  });
  afterAll(async () => {
    await disconnectPrisma();
    await db?.$disconnect();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  });
  it('retries the supported lifecycle write without editing the previously committed assignment or outbox', async () => {
    const actor = await db.domainRole.findFirstOrThrow({ where: { domain: 'admin.example.com', role: 'SUPERUSER' }, include: { user: true } });
    const target = await db.user.findFirstOrThrow({ where: { domainRoles: { none: {} } } });
    const member = await db.orgMember.findFirstOrThrow({ where: { userId: target.id } });
    const before = await db.directoryChangeOutbox.findMany({ where: { orgId: member.orgId }, orderBy: { revision: 'asc' } });
    expect(before.length).toBeGreaterThan(0);
    await setEntityLifecycle({ scope: 'USER', id: target.id, status: 'ACTIVE',
      actor: { userId: actor.userId, tokenVersion: actor.user.tokenVersion } });
    const after = await db.directoryChangeOutbox.findMany({ where: { orgId: member.orgId }, orderBy: { revision: 'asc' } });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ revision: before.at(-1)!.revision + 1n, kind: 'membership.changed', subjectId: target.id });
    expect(await db.orgMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ status: 'ACTIVE', role: 'member' });
  });
});
