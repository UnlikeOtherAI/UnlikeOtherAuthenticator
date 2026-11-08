import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createTestDb } from '../helpers/test-db.js';
import { seedOrganisationConsent } from '../helpers/organisation-consent-fixture.js';

describe.skipIf(process.env.BILLING_FUNDING_DATABASE_TESTS !== 'true')('locked organisation financial authority', () => {
  let handle: NonNullable<Awaited<ReturnType<typeof createTestDb>>>, db: PrismaClient;
  beforeAll(async () => {
    const created = await createTestDb(); if (!created) throw Error('Disposable PG required'); handle = created; db = created.prisma;
    await seedOrganisationConsent(db);
    for (const [id, role] of [['org-admin', 'admin'], ['team-admin', 'member']] as const) {
      await db.user.create({ data: { id, email: `${id}@authority.example.test`, userKey: id } });
      await db.orgMember.create({ data: { orgId: 'control-org', userId: id, role } });
    }
    await db.teamMember.create({ data: { teamId: 'control-team', userId: 'team-admin', teamRole: 'admin' } });
  });
  afterAll(async () => { await handle?.cleanup(); });
  const intent = (actor: string) => ({ appKeyId: 'control-key', serviceId: 'control-service', orgId: 'control-org', teamId: 'control-team',
    requestedByUserId: actor, authorityScope: 'ORGANISATION' as const, operation: 'stripe_portal', actorJti: randomUUID(),
    actorTokenVersion: 0, actorExpiresAt: new Date(Date.now() + 60000), requestDigest: 'a'.repeat(64) });
  it('requires current Org authority in the DB even with a valid lifecycle app and selected-team admin', async () => {
    for (const userId of ['control-owner', 'org-admin']) {
      await expect(db.$executeRaw(Prisma.sql`SELECT billing_assert_credit_scope_manager('control-org','control-team',${userId})`)).resolves.toBe(1);
      await expect(db.billingCustomerActionIntent.create({ data: intent(userId) })).resolves.toHaveProperty('id');
      expect(await db.teamMember.count({ where: { userId } })).toBe(0);
    }
    await expect(db.billingCustomerActionIntent.create({ data: intent('team-admin') })).rejects.toThrow('BILLING_MANAGER_REQUIRED');
  });
  it('cannot race a winning organisation-role demotion with a new financial intent', async () => {
    let release!: () => void, locked!: () => void, observedPid = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const demote = db.$transaction(async tx => {
      await tx.orgMember.update({ where: { orgId_userId: { orgId: 'control-org', userId: 'org-admin' } }, data: { role: 'member' } });
      locked(); await gate;
    }, { timeout: 20000 });
    let action: Promise<{ success: boolean; message?: string }> | undefined;
    try {
      await ready;
      action = db.$transaction(async tx => {
        observedPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.billingCustomerActionIntent.create({ data: intent('org-admin') });
      }, { timeout: 20000 }).then(() => ({ success: true }), error => ({ success: false, message: String(error) }));
      let waited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (observedPid) {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
            SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${observedPid}`);
          if (rows[0]?.waiting) { waited = true; break; }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waited).toBe(true); release(); await demote;
      expect(await action).toMatchObject({ success: false, message: expect.stringContaining('current exact authority') });
      expect(await db.billingCustomerActionIntent.count({ where: { requestedByUserId: 'org-admin' } })).toBe(1);
    } finally {
      release(); await Promise.allSettled([demote, ...(action ? [action] : [])]);
    }
  });
});
