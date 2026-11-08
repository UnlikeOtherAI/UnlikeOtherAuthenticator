import {
  BillingAppKeyPurpose, BillingAssignmentScope, MembershipStatus, Prisma, UserRole,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../helpers/test-db.js';
import { holdFinancialTransaction, startFinancialTransaction, waitForFinancialLock }
  from '../helpers/billing-financial-authority-race.js';
import { getAdminAuthDomain } from '../../src/config/env.js';
import { lockBillingAdminEffectAuthority } from '../../src/services/billing-admin-effect-authority.service.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('customer billing action intent authority races', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  let ids: { actor: string; appKey: string; org: string; service: string; team: string };
  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for DB-backed tests');
    const owner = await handle.prisma.user.create({
      data: { email: 'billing-intent-owner@example.com', userKey: 'billing-intent-owner' },
    });
    const actor = await handle.prisma.user.create({
      data: { email: 'billing-intent-actor@example.com', userKey: 'billing-intent-actor' },
    });
    const org = await handle.prisma.organisation.create({ data: {
      domain: 'billing-intent.example.com', name: 'Billing Intent Org',
      slug: 'billing-intent-org', ownerId: owner.id,
    } });
    await handle.prisma.orgMember.createMany({ data: [
      { orgId: org.id, userId: owner.id, role: 'owner' },
      { orgId: org.id, userId: actor.id, role: 'admin' },
    ] });
    const team = await handle.prisma.team.create({
      data: { orgId: org.id, name: 'Billing Intent Team', slug: 'billing-intent-team' },
    });
    await handle.prisma.teamMember.createMany({ data: [
      { teamId: team.id, userId: owner.id, teamRole: 'owner' },
      { teamId: team.id, userId: actor.id, teamRole: 'admin' },
    ] });
    await handle.prisma.domainRole.create({
      data: { domain: getAdminAuthDomain(), userId: actor.id, role: UserRole.SUPERUSER },
    });
    const service = await handle.prisma.billingService.create({
      data: { identifier: 'billing-intent-test', name: 'Billing Intent Test' },
    });
    const appKey = await handle.prisma.billingAppKey.create({ data: {
      serviceId: service.id, purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
      name: 'Billing action intent test', keyPrefix: 'uoa_intent_test', secretDigest: 'a'.repeat(64),
      actorIssuer: 'https://billing-intent.example.com', actorAudience: 'https://authentication.example.com/billing',
      actorKeyId: 'billing-intent-key', actorPublicJwk: {}, checkoutReturnOrigins: ['https://billing-intent.example.com'],
    } });
    ids = { actor: actor.id, appKey: appKey.id, org: org.id, service: service.id, team: team.id };
  });
  afterAll(async () => { await handle?.cleanup(); });

  function actionData(actorJti: string,
    overrides: Partial<Prisma.BillingCustomerActionIntentUncheckedCreateInput> = {},
  ): Prisma.BillingCustomerActionIntentUncheckedCreateInput {
    return {
      appKeyId: ids.appKey, serviceId: ids.service, orgId: ids.org, teamId: ids.team,
      requestedByUserId: ids.actor, authorityScope: BillingAssignmentScope.ORGANISATION,
      operation: 'credit_top_up', actorJti, actorTokenVersion: 0,
      actorExpiresAt: new Date(Date.now() + 60_000), requestDigest: 'b'.repeat(64), ...overrides,
    };
  }
  const orgActor = () => ({ orgId_userId: { orgId: ids.org, userId: ids.actor } });
  async function assertNoIntent(actorJti: string) {
    expect(await handle!.prisma.billingCustomerActionIntent.count({ where: { actorJti } })).toBe(0);
  }

  it('accepts current organisation authority with selected-team admission and keeps evidence append-only', async () => {
    const intent = await handle!.prisma.billingCustomerActionIntent.create({ data: actionData('actor-intent-success') });
    await expect(handle!.prisma.billingCustomerActionIntent.update({
      where: { id: intent.id }, data: { requestDigest: 'c'.repeat(64) },
    })).rejects.toBeDefined();
    await expect(handle!.prisma.billingCustomerActionIntent.delete({ where: { id: intent.id } })).rejects.toBeDefined();
  });

  it('refuses team-only administrators even when they are platform superusers', async () => {
    await handle!.prisma.orgMember.update({ where: orgActor(), data: { role: 'member' } });
    try {
      for (const authorityScope of [BillingAssignmentScope.TEAM, BillingAssignmentScope.ORGANISATION]) {
        const actorJti = 'actor-team-only-' + authorityScope;
        await expect(handle!.prisma.billingCustomerActionIntent.create({ data: actionData(actorJti, { authorityScope }) }))
          .rejects.toThrow('BILLING_MANAGER_REQUIRED');
        await assertNoIntent(actorJti);
      }
      expect(await handle!.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
      })).toMatchObject({ teamRole: 'admin', status: 'ACTIVE' });
    } finally {
      await handle!.prisma.orgMember.update({ where: orgActor(), data: { role: 'admin' } });
    }
  });

  it('waits for a winning org-role demotion and refuses the still-active team admin', async () => {
    const db = handle!.prisma;
    const winner = holdFinancialTransaction(db, tx => tx.orgMember.update({ where: orgActor(), data: { role: 'member' } }));
    let action: ReturnType<typeof startFinancialTransaction> | undefined;
    const actorJti = 'actor-intent-revoked';
    try {
      const blockerPid = await winner.ready;
      action = startFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({
        data: actionData(actorJti, { operation: 'stripe_portal', requestDigest: 'd'.repeat(64) }),
      }));
      await waitForFinancialLock(db, await action.started, blockerPid);
      winner.release();
      expect((await winner.result).ok).toBe(true);
      const outcome = await action.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(String(outcome.error)).toContain('BILLING_MANAGER_REQUIRED');
      await assertNoIntent(actorJti);
      expect(await db.teamMember.findUnique({
        where: { teamId_userId: { teamId: ids.team, userId: ids.actor } },
      })).toMatchObject({ teamRole: 'admin', status: 'ACTIVE' });
    } finally {
      winner.release();
      await Promise.allSettled([winner.result, action?.result]);
      await db.orgMember.update({ where: orgActor(), data: { role: 'admin' } });
    }
  }, 20_000);

  it('rejects the insertion signal on denied authority without leaving an unhandled transaction', async () => {
    const db = handle!.prisma;
    await db.orgMember.update({ where: orgActor(), data: { role: 'member' } });
    const denied = holdFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({
      data: actionData('actor-denied-before-signal'),
    }));
    try {
      await expect(denied.ready).rejects.toThrow('BILLING_MANAGER_REQUIRED');
      expect((await denied.result).ok).toBe(false);
      await assertNoIntent('actor-denied-before-signal');
    } finally {
      denied.release();
      await denied.result;
      await db.orgMember.update({ where: orgActor(), data: { role: 'admin' } });
    }
  });

  it('rechecks actor and app-key expiry against wall clock after waiting on the lock', async () => {
    const db = handle!.prisma;
    for (const expiry of ['actor', 'app_key'] as const) {
      const expiresAt = new Date(Date.now() + 300);
      const winner = holdFinancialTransaction(db, tx => tx.billingAppKey.update({ where: { id: ids.appKey },
        data: expiry === 'app_key' ? { expiresAt } : { name: 'Billing action intent test' },
      }));
      let action: ReturnType<typeof startFinancialTransaction> | undefined;
      const actorJti = 'actor-intent-expired-' + expiry;
      try {
        const blockerPid = await winner.ready;
        action = startFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({
          data: actionData(actorJti, { actorExpiresAt: expiry === 'actor' ? expiresAt : new Date(Date.now() + 60_000) }),
        }));
        await waitForFinancialLock(db, await action.started, blockerPid);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 50)));
        winner.release();
        expect((await winner.result).ok).toBe(true);
        expect((await action.result).ok).toBe(false);
        await assertNoIntent(actorJti);
      } finally {
        winner.release();
        await Promise.allSettled([winner.result, action?.result]);
        await db.billingAppKey.update({ where: { id: ids.appKey }, data: { expiresAt: null } });
      }
    }
  }, 20_000);

  it('rejects org membership and app-key revocation committed while an action waits', async () => {
    const db = handle!.prisma;
    const cases = [
      { name: 'org', revoke: (tx: Prisma.TransactionClient) => tx.orgMember.update({
        where: orgActor(), data: { status: MembershipStatus.DEACTIVATED },
      }), restore: () => db.orgMember.update({ where: orgActor(), data: { status: MembershipStatus.ACTIVE } }) },
      { name: 'app-key', revoke: (tx: Prisma.TransactionClient) => tx.billingAppKey.update({
        where: { id: ids.appKey }, data: { revokedAt: new Date() },
      }), restore: () => db.billingAppKey.update({ where: { id: ids.appKey }, data: { revokedAt: null } }) },
    ];
    for (const testCase of cases) {
      const winner = holdFinancialTransaction(db, testCase.revoke);
      let action: ReturnType<typeof startFinancialTransaction> | undefined;
      const actorJti = 'actor-intent-revoked-' + testCase.name;
      try {
        const blockerPid = await winner.ready;
        action = startFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({ data: actionData(actorJti) }));
        await waitForFinancialLock(db, await action.started, blockerPid);
        winner.release();
        expect((await winner.result).ok).toBe(true);
        expect((await action.result).ok).toBe(false);
        await assertNoIntent(actorJti);
      } finally {
        winner.release();
        await Promise.allSettled([winner.result, action?.result]);
        await testCase.restore();
      }
    }
  }, 20_000);

  it('rejects stale customer and admin credential epochs after a concurrent revocation', async () => {
    const db = handle!.prisma;
    const winner = holdFinancialTransaction(db, tx => tx.user.update({ where: { id: ids.actor }, data: { tokenVersion: 1 } }));
    let customer: ReturnType<typeof startFinancialTransaction> | undefined;
    let admin: ReturnType<typeof startFinancialTransaction> | undefined;
    try {
      const blockerPid = await winner.ready;
      customer = startFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({ data: actionData('actor-intent-stale-epoch') }));
      admin = startFinancialTransaction(db, tx => lockBillingAdminEffectAuthority(tx, {
        userId: ids.actor, tokenVersion: 0, email: 'billing-intent-actor@example.com',
      }));
      await waitForFinancialLock(db, await customer.started, blockerPid);
      await waitForFinancialLock(db, await admin.started, blockerPid);
      winner.release();
      expect((await winner.result).ok).toBe(true);
      expect((await customer.result).ok).toBe(false);
      expect((await admin.result).ok).toBe(false);
      await assertNoIntent('actor-intent-stale-epoch');
    } finally {
      winner.release();
      await Promise.allSettled([winner.result, customer?.result, admin?.result]);
      await db.user.update({ where: { id: ids.actor }, data: { tokenVersion: 0 } });
    }
  }, 20_000);

  it('lets an intent linearized first commit before a later org-role demotion', async () => {
    const db = handle!.prisma;
    const actorJti = 'actor-intent-first';
    const winner = holdFinancialTransaction(db, tx => tx.billingCustomerActionIntent.create({ data: actionData(actorJti) }));
    let revocation: ReturnType<typeof startFinancialTransaction> | undefined;
    try {
      const blockerPid = await winner.ready;
      revocation = startFinancialTransaction(db, tx => tx.orgMember.update({ where: orgActor(), data: { role: 'member' } }));
      await waitForFinancialLock(db, await revocation.started, blockerPid);
      winner.release();
      expect((await winner.result).ok).toBe(true);
      expect((await revocation.result).ok).toBe(true);
      expect(await db.billingCustomerActionIntent.count({ where: { actorJti } })).toBe(1);
      await expect(db.billingCustomerActionIntent.create({ data: actionData('actor-after-demotion') }))
        .rejects.toThrow('BILLING_MANAGER_REQUIRED');
      await assertNoIntent('actor-after-demotion');
    } finally {
      winner.release();
      await Promise.allSettled([winner.result, revocation?.result]);
      await db.orgMember.update({ where: orgActor(), data: { role: 'admin' } });
    }
  }, 20_000);
});
