import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { executeEntityDeletion } from '../../src/services/entity-deletion-job.service.js';

const store = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock('../../src/db/prisma.js', () => ({ getAdminPrisma: () => store.db!, getPrisma: () => store.db! }));
const schema = process.env.UOA_AUDIT_RECOVERY_SCHEMA;

// Explicit audit-only continuation. No fixture seeding, reset, lease edits or
// cleanup: it exercises the supported service against the retained failed job.
describe.skipIf(!process.env.DATABASE_URL || !schema)('retained deletion job recovery', () => {
  const original = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '55460' || url.pathname !== '/uoa_api_audit' ||
      !/^test_\d+_[a-f0-9]{32}$/.test(schema!)) throw new Error('Recovery requires the explicit owned audit database/schema');
    url.searchParams.set('schema', schema!);
    process.env.DATABASE_URL = url.toString();
    process.env.DATABASE_ADMIN_URL = url.toString();
    store.db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await store.db.$connect();
  });
  afterAll(async () => {
    await store.db?.$disconnect();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
  });

  it('resumes the original progress after natural lease expiry without duplicate effects', async () => {
    const db = store.db!;
    const jobs = await db.entityDeletionJob.findMany({ where: { status: { not: 'COMPLETE' } }, include: { participants: true } });
    expect(jobs).toHaveLength(1);
    let job = jobs[0];
    expect(job.participants.every(participant => participant.acknowledgedAt)).toBe(true);
    const role = await db.domainRole.findFirstOrThrow({ where: { domain: getAdminAuthDomain(), role: 'SUPERUSER' }, select: { userId: true } });
    const actor = await db.user.findUniqueOrThrow({ where: { id: role.userId }, select: { id: true, tokenVersion: true } });
    const preview = job.preview as unknown as { organisationId: string; candidates: Array<{ eligible: boolean }> };
    const before = await db.directoryOrganisationRevision.findUniqueOrThrow({ where: { orgId: preview.organisationId } });
    expect(before.terminal).toBe(true);
    const wait = (job.leaseExpiresAt?.getTime() ?? 0) - Date.now() + 50;
    if (wait > 0) {
      console.info(`Waiting for natural audit lease expiry: ${Math.ceil(wait / 1000)} seconds`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    let attempts = 0;
    while (job.status !== 'COMPLETE' && attempts++ < 20) {
      job = await executeEntityDeletion(job.id, { userId: actor.id, tokenVersion: actor.tokenVersion });
      console.info(`Supported deletion recovery attempt ${attempts}: ${job.status}`);
    }
    expect(job.status).toBe('COMPLETE');
    expect(job.progress).toMatchObject({ scopeCleaned: true, accountsCompleted: preview.candidates.filter(candidate => candidate.eligible).length });
    expect(await db.adminAuditLog.count({ where: { action: 'scale.test' } })).toBe(250);
    const audit = JSON.stringify(await db.adminAuditLog.findMany({ where: { action: 'scale.test' } }));
    expect(audit.includes('192.0.2.4')).toBe(false);
    const after = await db.directoryOrganisationRevision.findUniqueOrThrow({ where: { orgId: preview.organisationId } });
    expect(after).toEqual(before);
    expect(await db.directoryChangeOutbox.findFirst({ where: { orgId: preview.organisationId }, orderBy: { revision: 'desc' } }))
      .toMatchObject({ kind: 'organisation.deleted', revision: before.revision });
  }, 300_000);
});
